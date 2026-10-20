import type { Types } from 'mongoose';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import {
  CampaignModel,
  emptyCampaignStats,
  type CampaignDoc,
} from '../../db/models/campaign.model';
import type { Logger } from '../../shared/logger';

import { beginRun, isNotRunnableError, nameTaken, setStatus } from './campaigns.service';
import { notifyRunSkipped } from './notifications';
import { nextOccurrence, runLabel } from './recurrence';

/** BullMQ job scheduler id of a recurring parent (ids use '-', never ':'). */
export const runSchedulerId = (campaignId: string) => `runs-${campaignId}`;

/** A job may fire a moment before the stored time (clock skew between Redis and us). */
const EARLY_MS = 5_000;

const RUN_STATUSES_ACTIVE = ['scheduled', 'running', 'paused'] as const;

const runName = async (parent: CampaignDoc, at: Date, runNumber: number): Promise<string> => {
  const label = ` · ${runLabel(at, parent.schedule.timezone)}`;
  const fit = (end: string) =>
    `${parent.name.slice(0, CAMPAIGN_LIMITS.nameMaxChars - end.length)}${end}`;
  const name = fit(label);
  if (!(await nameTaken(parent.accountId, name))) return name;
  return fit(`${label} (run ${String(runNumber)})`);
};

/** The child campaign of one occurrence: the parent's settings, a fresh draft. */
const createRunDoc = async (parent: CampaignDoc, at: Date): Promise<CampaignDoc> => {
  const last = await CampaignModel.findOne({ parentId: parent._id })
    .sort({ runNumber: -1 })
    .select({ runNumber: 1 })
    .lean<{ runNumber: number | null }>();
  const runNumber = (last?.runNumber ?? 0) + 1;
  const created = await CampaignModel.create({
    accountId: parent.accountId,
    name: await runName(parent, at, runNumber),
    mode: parent.mode,
    flowId: parent.flowId,
    // pinned: the version the parent pinned when it was scheduled; latest: decided at start
    chosenVersion: parent.versionPolicy === 'pinned' ? parent.flowVersion : null,
    versionPolicy: parent.versionPolicy,
    audience: parent.audience,
    schedule: {
      startAt: null,
      endAt: null,
      timezone: parent.schedule.timezone,
      recurrence: null,
    },
    window: parent.window,
    retry: parent.retry,
    followUps: parent.followUps,
    pacing: parent.pacing,
    autoResume: parent.autoResume,
    dryRun: parent.dryRun,
    status: 'draft',
    stats: emptyCampaignStats(),
    parentId: parent._id,
    runNumber,
    startedBy: parent.startedBy,
    createdBy: parent.startedBy,
    updatedBy: parent.startedBy,
    history: [{ at: new Date(), status: 'draft', pauseReason: null, by: null }],
  });
  return created.toObject({ transform: false });
};

export type RunResult = 'created' | 'skipped' | 'failed' | 'not_due';

/**
 * Runs the parent's due occurrence once (PHASE_8_PLAN §1g): claims `nextRunAt`
 * with compare-and-set (the scheduler job and the sweep may both try), moves it
 * to the following occurrence (missed ones are not made up), skips while the
 * previous run is active, else creates the run and starts it now. The parent
 * completes after its last occurrence.
 */
export const runDue = async (
  parentId: Types.ObjectId | string,
  now: Date,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<RunResult> => {
  const parent = await CampaignModel.findById(parentId).lean<CampaignDoc>();
  if (!parent?.schedule.recurrence || parent.status !== 'scheduled' || parent.deletedAt) {
    return 'not_due';
  }
  const due = parent.nextRunAt;
  if (!due || due.getTime() > now.getTime() + EARLY_MS) return 'not_due';
  const following = nextOccurrence(
    parent.schedule.recurrence,
    parent.schedule.timezone,
    new Date(Math.max(now.getTime(), due.getTime())),
  );
  const claimed = await CampaignModel.findOneAndUpdate(
    { _id: parent._id, status: 'scheduled', nextRunAt: due },
    { $set: { nextRunAt: following } },
    { returnDocument: 'after' },
  ).lean<CampaignDoc>();
  if (!claimed) return 'not_due';
  const finish = async () => {
    if (following) return;
    await setStatus(claimed, 'completed', { set: { completedAt: new Date() } }).catch(
      () => undefined,
    );
  };
  const active = await CampaignModel.exists({
    parentId: parent._id,
    status: { $in: RUN_STATUSES_ACTIVE },
  });
  if (active) {
    logger.info({ campaignId: parent._id.toString() }, 'campaign: run skipped (previous active)');
    await notifyRunSkipped(claimed);
    await finish();
    return 'skipped';
  }
  const run = await createRunDoc(claimed, due);
  let result: RunResult = 'created';
  try {
    await beginRun(run, parent.startedBy);
  } catch (err) {
    if (!isNotRunnableError(err)) throw err;
    logger.warn({ campaignId: run._id.toString(), code: err.code }, 'campaign: run start failed');
    await setStatus(run, 'failed', { set: { error: { code: 'CAMPAIGN_NOT_RUNNABLE' } } }).catch(
      () => undefined,
    );
    result = 'failed';
  }
  await finish();
  return result;
};

/** Recurring parents whose occurrence is due (sweep safety net for lost scheduler jobs). */
export const dueParents = async (now: Date): Promise<Types.ObjectId[]> =>
  (
    await CampaignModel.find({
      status: 'scheduled',
      'schedule.recurrence': { $ne: null },
      nextRunAt: { $lte: now },
    })
      .select({ _id: 1 })
      .limit(CAMPAIGN_LIMITS.sweepBatch)
      .lean<{ _id: Types.ObjectId }[]>()
  ).map((c) => c._id);
