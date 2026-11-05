import { createHash } from 'node:crypto';

import type { Job, JobsOptions, Queue } from 'bullmq';
import { Types } from 'mongoose';

import { availableMicros, walletEvents, type WalletChange } from '../../core/billing/events';
import type { StorageProvider } from '../../core/storage';
import { CampaignContactModel } from '../../db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../db/models/campaign.model';
import { AppError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import type { CallManager } from '../calls/call.service';
import type { CallingRuntime } from '../whatsapp-calling/runtime';

import {
  pauseCampaignDoc,
  pinnedProblems,
  resumeCampaignDoc,
  setCampaignHooks,
  startScheduled,
} from './campaigns.service';
import { completeCampaign, virtualRoom, type CampaignDispatcher } from './dispatcher';
import { runCampaignExport, type CampaignExportJobs } from './export';
import { cronOf } from './recurrence';
import { runDue, runSchedulerId } from './runs';
import { sweepCampaigns } from './sweep';
import { runVoiceBatch, setVoiceStorage } from './voice-api/batch';
import type { VoiceJobData } from './voice-api/jobs';
import { applyVoiceResult, pollVoiceCampaign } from './voice-api/results';
import { voiceRunProblems, voicePrice } from './voice-api/settings';

/** Campaign jobs (PHASE_8_PROMPT §1 "Queue + jobs"); job data = ids only. */
export interface CampaignJobData {
  'campaign.start': { campaignId: string };
  'campaign.end': { campaignId: string };
  'campaign.wake': { accountId: string };
  /** One occurrence of a recurring parent (job scheduler `runs-<id>`). */
  'campaign.run': { campaignId: string };
  /** Results export (CSV / XLSX) of a campaign. */
  'campaign.export': { accountId: string; exportJobId: string };
  'campaigns.sweep': Record<string, never>;
  /** VAPI: recorded-voice batch tick, results poll, one number's result. */
  'voice.batch': VoiceJobData['voice.batch'];
  'voice.poll': VoiceJobData['voice.poll'];
  'voice.result': VoiceJobData['voice.result'];
}
export type CampaignJobName = keyof CampaignJobData;

export const CAMPAIGN_JOB_NAMES = [
  'campaign.start',
  'campaign.end',
  'campaign.wake',
  'campaign.run',
  'campaign.export',
  'campaigns.sweep',
  'voice.batch',
  'voice.poll',
  'voice.result',
] as const satisfies readonly CampaignJobName[];

export const CAMPAIGN_SCHEDULES = [
  { name: 'campaigns.sweep', pattern: '*/1 * * * *' },
] as const satisfies readonly { name: CampaignJobName; pattern: string }[];

const OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};
const RUN_OPTIONS = { ...OPTIONS, attempts: 1 } as const;

/** BullMQ custom job ids may not contain ':' — ids use '-'. */
export const startJobId = (campaignId: string) => `start-${campaignId}`;
export const endJobId = (campaignId: string) => `end-${campaignId}`;

/** Timing jobs of campaigns (the API depends on this, not on BullMQ). */
export interface CampaignJobs {
  /** (Re)schedules the delayed start at `schedule.startAt` and the end at `schedule.endAt`. */
  schedule(campaign: CampaignDoc): Promise<void>;
  /** (Re)schedules only the end (a running campaign). */
  scheduleEnd(campaign: CampaignDoc): Promise<void>;
  drop(campaign: CampaignDoc): Promise<void>;
}

export const queueCampaignJobs = (queue: Queue, now: () => number = Date.now): CampaignJobs => {
  const replace = async (jobId: string, name: CampaignJobName, data: object, at: Date | null) => {
    await queue.remove(jobId);
    if (at)
      await queue.add(name, data, { ...OPTIONS, jobId, delay: Math.max(0, at.getTime() - now()) });
  };
  const scheduleEnd = (c: CampaignDoc) =>
    replace(
      endJobId(c._id.toString()),
      'campaign.end',
      { campaignId: c._id.toString() },
      c.schedule.endAt,
    );
  return {
    async schedule(c) {
      const recurrence = c.schedule.recurrence;
      if (recurrence) {
        // cron in the campaign timezone; the sweep is the safety net (`nextRunAt`)
        await queue.upsertJobScheduler(
          runSchedulerId(c._id.toString()),
          {
            pattern: cronOf(recurrence),
            tz: c.schedule.timezone,
            ...(recurrence.until ? { endDate: recurrence.until } : {}),
          },
          { name: 'campaign.run', data: { campaignId: c._id.toString() }, opts: RUN_OPTIONS },
        );
      }
      const startAt = recurrence ? null : c.schedule.startAt;
      await replace(
        startJobId(c._id.toString()),
        'campaign.start',
        { campaignId: c._id.toString() },
        startAt,
      );
      await scheduleEnd(c);
    },
    scheduleEnd,
    async drop(c) {
      await queue.remove(startJobId(c._id.toString()));
      await queue.remove(endJobId(c._id.toString()));
      await queue.removeJobScheduler(runSchedulerId(c._id.toString()));
    },
  };
};

export interface CampaignJobContext {
  dispatcher: CampaignDispatcher;
  logger: Logger;
  /** Export files (absent: export jobs fail). */
  storage?: StorageProvider;
}

/** The API's port into the queue for results exports (`export-<id>` job ids). */
export const queueCampaignExports = (queue: Queue): CampaignExportJobs => ({
  async enqueue(data) {
    await queue.add('campaign.export', data, { ...OPTIONS, jobId: `export-${data.exportJobId}` });
  },
});

export const processCampaignJob =
  (ctx: CampaignJobContext) =>
  async (job: Job): Promise<unknown> => {
    switch (job.name as CampaignJobName) {
      case 'campaign.start': {
        const { campaignId } = job.data as CampaignJobData['campaign.start'];
        const campaign = await CampaignModel.findById(campaignId).lean<CampaignDoc>();
        if (campaign) await startScheduled(campaign, ctx.logger);
        return null;
      }
      case 'campaign.end': {
        const { campaignId } = job.data as CampaignJobData['campaign.end'];
        const campaign = await CampaignModel.findById(campaignId).lean<CampaignDoc>();
        if (campaign && ['running', 'paused', 'scheduled'].includes(campaign.status)) {
          await completeCampaign(campaign, 'campaign_ended');
        }
        return null;
      }
      case 'campaign.run': {
        const { campaignId } = job.data as CampaignJobData['campaign.run'];
        return runDue(campaignId, new Date(), ctx.logger);
      }
      case 'campaign.export': {
        if (!ctx.storage) throw new Error('Campaign exports need file storage');
        return runCampaignExport(job.data as CampaignJobData['campaign.export'], {
          storage: ctx.storage,
          logger: ctx.logger,
        });
      }
      case 'campaign.wake':
        ctx.dispatcher.wake((job.data as CampaignJobData['campaign.wake']).accountId);
        return null;
      case 'campaigns.sweep':
        return sweepCampaigns({ dispatcher: ctx.dispatcher, logger: ctx.logger });
      case 'voice.batch':
        setVoiceStorage(ctx.storage);
        return runVoiceBatch((job.data as CampaignJobData['voice.batch']).campaignId, {
          storage: ctx.storage,
        });
      case 'voice.poll':
        return pollVoiceCampaign((job.data as CampaignJobData['voice.poll']).campaignId);
      case 'voice.result':
        return applyVoiceResult(job.data as CampaignJobData['voice.result']);
      default:
        throw new Error(`Unknown campaign job "${job.name}"`);
    }
  };

/** Why a paused campaign can't resume yet (PHASE_8_PLAN §1j), or `null`. */
export const resumeBlocker = async (campaign: CampaignDoc): Promise<string | null> => {
  if (campaign.pauseReason === 'provider_uncertain') {
    return 'Support must first check whether the last recorded-voice batch was sent.';
  }
  if (campaign.pauseReason === 'provider_error') {
    const problems = await voiceRunProblems(campaign);
    if (problems.length) return problems[0]?.message ?? 'Recorded voice cannot run yet.';
    const price = await voicePrice(campaign.accountId, campaign.voiceApi?.audioSec ?? 0);
    return price.notPriced ? 'Recorded voice has no price yet — ask support.' : null;
  }
  if (campaign.pauseReason === 'flow_not_runnable') {
    const problems = await pinnedProblems(campaign);
    return problems.length ? `The flow can't run yet: ${problems[0]?.message ?? ''}` : null;
  }
  if (campaign.pauseReason !== 'wallet_empty' && campaign.pauseReason !== 'budget_reached') {
    return null;
  }
  if ((await virtualRoom(campaign)) > 0) return null;
  return campaign.mode === 'dry_run'
    ? 'The wallet would run out (dry run) — add money to resume.'
    : 'Add money to resume.';
};

/**
 * Wires the campaign service to the scheduler: hooks (jobs, dispatcher wake,
 * hang-ups, resume gate), wallet auto-resume after a credit. Returns a cleanup.
 */
export const wireCampaigns = (deps: {
  jobs: CampaignJobs;
  dispatcher: CampaignDispatcher;
  calls: CallManager;
  calling?: CallingRuntime;
  logger: Logger;
}): (() => void) => {
  setCampaignHooks({
    scheduled: (c) => deps.jobs.schedule(c),
    unscheduled: (c) => deps.jobs.drop(c),
    running: async (c) => {
      if (c.line === 'whatsapp' && c.askPermissionFirst && c.channelId && c.createdBy) {
        if (!deps.calling) throw new AppError('PROVIDER_UNAVAILABLE');
        const rows = await CampaignContactModel.find({
          campaignId: c._id,
          accountId: c.accountId,
          status: { $in: ['pending', 'retry_wait'] },
        })
          .sort({ seq: 1 })
          .select({ contactId: 1 })
          .lean();
        for (let offset = 0; offset < rows.length; offset += 5000) {
          const ids = rows.slice(offset, offset + 5000).map((r) => r.contactId.toString());
          const runId = createHash('sha1')
            .update(`campaign-permissions:${c._id.toString()}:${ids[0] ?? ''}`)
            .digest('hex')
            .slice(0, 24);
          await deps.calling.bulk.start(
            { type: 'system', id: null, accountId: c.accountId, userId: c.createdBy },
            {
              runId,
              channelId: c.channelId.toString(),
              target: { contactIds: ids },
              templateId: c.askPermissionFirst.templateId.toString(),
            },
          );
        }
      }
      await deps.jobs.scheduleEnd(c);
      deps.dispatcher.wake(c.accountId.toString());
    },
    hangUpLive: async (c) => {
      await deps.calls.hangupCampaign(c._id.toString());
      await deps.calling?.calls?.hangupCampaign(c._id.toString());
    },
    resumeBlocker,
  });
  const onWallet = (change: WalletChange) => {
    // only a balance that went up can lift a wallet pause
    if (availableMicros(change.after) <= availableMicros(change.before)) return;
    void autoResume(change.accountId, deps.logger).catch((err: unknown) =>
      deps.logger.error({ err }, 'campaign: auto-resume failed'),
    );
  };
  walletEvents.on('updated', onWallet);
  return () => {
    walletEvents.off('updated', onWallet);
    setCampaignHooks({});
  };
};

/** After a credit: wallet-paused campaigns with `autoResume` resume when the gate passes. */
export const autoResume = async (accountId: string, logger: Logger): Promise<number> => {
  const paused = await CampaignModel.find({
    accountId: new Types.ObjectId(accountId),
    status: 'paused',
    pauseReason: 'wallet_empty',
    autoResume: true,
  }).lean<CampaignDoc[]>();
  let resumed = 0;
  for (const c of paused) {
    if (await resumeBlocker(c)) continue;
    try {
      await resumeCampaignDoc(c, null);
      resumed += 1;
    } catch (err) {
      logger.warn({ err, campaignId: c._id.toString() }, 'campaign: auto-resume refused');
    }
  }
  return resumed;
};

/** Account suspended: running / scheduled campaigns pause (enabling does not resume). */
export const pauseAccountCampaigns = async (
  accountId: Types.ObjectId | string,
  reason: 'account_suspended' | 'admin',
): Promise<number> => {
  const active = await CampaignModel.find({
    accountId: new Types.ObjectId(String(accountId)),
    status: { $in: ['running', 'scheduled'] },
  }).lean<CampaignDoc[]>();
  let paused = 0;
  for (const c of active) {
    await pauseCampaignDoc(c, reason, null)
      .then(() => (paused += 1))
      .catch(() => undefined);
  }
  return paused;
};
