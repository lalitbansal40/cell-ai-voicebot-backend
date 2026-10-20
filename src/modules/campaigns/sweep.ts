import { CAMPAIGN_LIMITS } from '../../config/limits';
import { CallModel, LIVE_CALL_STATUSES, type CallDoc } from '../../db/models/call.model';
import { CampaignContactModel } from '../../db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../db/models/campaign.model';
import type { Logger } from '../../shared/logger';

import { usedFields } from './audience';
import { loadFlowVersion, resumeCampaignDoc, startScheduled } from './campaigns.service';
import { applyResult, completeCampaign, moveStats, type CampaignDispatcher } from './dispatcher';
import { contactCounts, countsToStats, takeSnapshot } from './snapshot';

export interface SweepResult {
  started: number;
  snapshots: number;
  ended: number;
  released: number;
  applied: number;
  recounted: number;
  resumed: number;
}

const COUNTED = [
  'total',
  'pending',
  'queued',
  'calling',
  'waiting',
  'completed',
  'failed',
  'skipped',
  'canceled',
] as const;

/**
 * Every minute (PHASE_8_PLAN §1k): starts scheduled campaigns whose time passed
 * (lost jobs, restarts), finishes interrupted snapshots, keeps the dispatcher
 * loops alive, ends campaigns past `endAt`, gives back stale claims, applies
 * results of campaign calls that ended while nobody listened, recounts drifted
 * stats and lifts budget pauses when the budget allows again.
 */
export const sweepCampaigns = async (deps: {
  dispatcher: CampaignDispatcher;
  logger: Logger;
  now?: Date;
}): Promise<SweepResult> => {
  const now = deps.now ?? new Date();
  const result: SweepResult = {
    started: 0,
    snapshots: 0,
    ended: 0,
    released: 0,
    applied: 0,
    recounted: 0,
    resumed: 0,
  };

  const due = await CampaignModel.find({
    status: 'scheduled',
    'schedule.recurrence': null,
    'schedule.startAt': { $lte: now },
  }).lean<CampaignDoc[]>();
  for (const c of due) {
    await startScheduled(c, deps.logger).catch((err: unknown) =>
      deps.logger.error({ err, campaignId: c._id.toString() }, 'campaign: sweep start failed'),
    );
    result.started += 1;
  }

  const unfinished = await CampaignModel.find({ status: 'running', 'snapshot.done': false }).lean<
    CampaignDoc[]
  >();
  for (const c of unfinished) {
    const pinned = await loadFlowVersion(c.accountId, c.flowId, c.flowVersion);
    await takeSnapshot(
      c,
      await usedFields(c.accountId, pinned.graph, pinned.version.agentIds),
      c.startedAt ?? now,
    );
    result.snapshots += 1;
  }

  const ended = await CampaignModel.find({
    status: { $in: ['running', 'paused'] },
    'schedule.endAt': { $lte: now },
  }).lean<CampaignDoc[]>();
  for (const c of ended) {
    await completeCampaign(c, 'campaign_ended');
    result.ended += 1;
  }

  // claims that never became a call (a crash between claim and dial)
  const stale = await CampaignContactModel.find({
    status: 'queued',
    claimedAt: { $lt: new Date(now.getTime() - CAMPAIGN_LIMITS.claimLeaseMs) },
  }).lean();
  for (const cc of stale) {
    const moved = await CampaignContactModel.updateOne(
      { _id: cc._id, status: 'queued' },
      { $set: { status: 'retry_wait', nextAttemptAt: now, claimToken: null, claimedAt: null } },
    );
    if (moved.modifiedCount) {
      await CampaignModel.updateOne(
        { _id: cc.campaignId },
        { $inc: moveStats('queued', 'retry_wait') },
      );
      result.released += 1;
    }
  }

  // contacts on a call that ended without its result applied (the process died)
  const calling = await CampaignContactModel.find({
    status: 'calling',
    lastAttemptAt: { $lt: new Date(now.getTime() - CAMPAIGN_LIMITS.claimLeaseMs) },
  }).lean();
  for (const cc of calling) {
    const call = cc.lastCallId ? await CallModel.findById(cc.lastCallId).lean<CallDoc>() : null;
    if (call && !LIVE_CALL_STATUSES.includes(call.status)) {
      await applyResult(call, now);
      result.applied += 1;
    } else if (!call) {
      const moved = await CampaignContactModel.updateOne(
        { _id: cc._id, status: 'calling' },
        {
          $set: { status: 'retry_wait', nextAttemptAt: now, claimToken: null, claimedAt: null },
          $inc: { attempts: -1 },
        },
      );
      if (moved.modifiedCount) {
        await CampaignModel.updateOne(
          { _id: cc.campaignId },
          { $inc: { ...moveStats('calling', 'retry_wait'), 'stats.attempts': -1 } },
        );
        result.released += 1;
      }
    }
  }

  const active = await CampaignModel.find({ status: { $in: ['running', 'paused'] } }).lean<
    CampaignDoc[]
  >();
  for (const c of active) {
    if (!c.snapshot.done) continue;
    const counts = await contactCounts(c._id);
    const stats = countsToStats(counts);
    const drift = COUNTED.some((k) => stats[`stats.${k}`] !== c.stats[k]);
    if (drift) {
      deps.logger.warn({ campaignId: c._id.toString() }, 'campaign: stats drift recounted');
      await CampaignModel.updateOne({ _id: c._id }, { $set: stats });
      result.recounted += 1;
    }
  }

  const budget = await CampaignModel.find({
    status: 'paused',
    pauseReason: 'budget_reached',
    autoResume: true,
  }).lean<CampaignDoc[]>();
  for (const c of budget) {
    await resumeCampaignDoc(c, null)
      .then(() => (result.resumed += 1))
      .catch(() => undefined);
  }

  const accounts = new Set(
    (await CampaignModel.distinct('accountId', { status: 'running' })).map((id) => id.toString()),
  );
  for (const accountId of accounts) deps.dispatcher.ensureAccount(accountId);
  return result;
};
