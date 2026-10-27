import { CALL_LIMITS, RETENTION_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { AnalyticsMarkModel, analyticsMarkId } from '../../db/models/analytics-mark.model';
import { CallEventModel } from '../../db/models/call-event.model';
import { CallInsightModel } from '../../db/models/call-insight.model';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import { FlowRunModel } from '../../db/models/flow-run.model';
import { TranscriptTurnModel } from '../../db/models/transcript-turn.model';
import type { Logger } from '../../shared/logger';
import { effectiveRetention } from '../retention/retention.service';

import { CallBilling } from './billing';
import type { CallRegistry } from './registry';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Calls whose process died: `ringing` / `in_progress` without a live registry
 * key for > 60 s → failed (`server_shutdown`), billed for the time we know;
 * `queued` > 15 min → canceled, hold released.
 */
export const reapCalls = async (
  registry: CallRegistry,
  logger: Logger,
  now: Date = new Date(),
): Promise<{ failed: number; canceled: number }> => {
  const stale = new Date(now.getTime() - CALL_LIMITS.staleHeartbeatSec * 1000);
  let failed = 0;
  let canceled = 0;
  const running = await CallModel.find({
    status: { $in: ['ringing', 'in_progress'] },
    updatedAt: { $lt: stale },
  }).lean<CallDoc[]>();
  for (const call of running) {
    const callId = call._id.toString();
    if (await registry.isLive(callId)) continue;
    const answeredAt = call.timestamps.answeredAt;
    const billing = new CallBilling(call.accountId.toString(), callId, call.provider !== 'webcall');
    billing.holdId = call.holdId?.toString() ?? null;
    const durationSec = answeredAt
      ? Math.max(0, Math.round((call.updatedAt.getTime() - answeredAt.getTime()) / 1000))
      : 0;
    try {
      if (answeredAt && billing.holdId) {
        await billing.settle({
          answered: true,
          durationSec,
          aiSeconds: 0,
          ttsChars: call.metrics.ttsChars,
        });
      } else {
        await billing.release('stale');
      }
    } catch (err) {
      logger.error({ err, callId }, 'calls-reaper: billing failed');
    }
    await CallModel.updateOne(
      { _id: call._id, status: call.status },
      {
        $set: {
          status: 'failed',
          endReason: 'server_shutdown',
          durationSec,
          'timestamps.endedAt': now,
          error: { code: 'server_shutdown' },
        },
      },
    );
    await registry.unregister(callId, call.accountId.toString()).catch(() => undefined);
    failed += 1;
  }
  const queuedBefore = new Date(now.getTime() - CALL_LIMITS.queuedStaleMin * 60_000);
  const queued = await CallModel.find({ status: 'queued', createdAt: { $lt: queuedBefore } }).lean<
    CallDoc[]
  >();
  for (const call of queued) {
    const billing = new CallBilling(call.accountId.toString(), call._id.toString(), false);
    billing.holdId = call.holdId?.toString() ?? null;
    await billing
      .release('not_connected')
      .catch((err: unknown) =>
        logger.error({ err, callId: call._id.toString() }, 'calls-reaper: release failed'),
      );
    await CallModel.updateOne(
      { _id: call._id, status: 'queued' },
      { $set: { status: 'canceled', endReason: 'canceled', 'timestamps.endedAt': now } },
    );
    canceled += 1;
  }
  return { failed, canceled };
};

type PurgeCall = Pick<CallDoc, '_id' | 'recording' | 'flowRunId'>;

const deleteQuietly = async (storage: StorageProvider | undefined, key: string) => {
  if (!storage) return;
  try {
    await storage.delete(key);
  } catch {
    // already gone — the purge stays resumable
  }
};

/** Deletes matching calls with everything hanging off them, 1 000 at a time. */
const deleteCalls = async (
  storage: StorageProvider | undefined,
  filter: Record<string, unknown>,
): Promise<number> => {
  let deleted = 0;
  for (;;) {
    const batch = await CallModel.find(filter)
      .select({ recording: 1, flowRunId: 1 })
      .limit(RETENTION_LIMITS.purgeBatch)
      .lean<PurgeCall[]>();
    if (!batch.length) return deleted;
    for (const call of batch)
      if (call.recording && !call.recording.deletedAt)
        await deleteQuietly(storage, call.recording.fileKey);
    const ids = batch.map((c) => c._id);
    await CallEventModel.deleteMany({ callId: { $in: ids } });
    await TranscriptTurnModel.deleteMany({ callId: { $in: ids } });
    await CallInsightModel.deleteMany({ callId: { $in: ids } });
    const runs = batch.flatMap((c) => (c.flowRunId ? [c.flowRunId] : []));
    if (runs.length) await FlowRunModel.deleteMany({ _id: { $in: runs }, mode: 'call' });
    await CallModel.deleteMany({ _id: { $in: ids } });
    // their counts stay in the report rollups; only the bookkeeping goes
    await AnalyticsMarkModel.deleteMany({
      _id: { $in: ids.map((id) => analyticsMarkId('call', id)) },
    });
    deleted += batch.length;
  }
};

/** Deletes recording files only: the call, transcript and insights stay (`recording.deletedAt`). */
const deleteRecordings = async (
  storage: StorageProvider | undefined,
  filter: Record<string, unknown>,
  now: Date,
): Promise<number> => {
  if (!storage) return 0;
  let deleted = 0;
  for (;;) {
    const batch = await CallModel.find({
      ...filter,
      recording: { $ne: null },
      'recording.deletedAt': null,
    })
      .select({ recording: 1 })
      .limit(RETENTION_LIMITS.purgeBatch)
      .lean<PurgeCall[]>();
    if (!batch.length) return deleted;
    for (const call of batch)
      if (call.recording) await deleteQuietly(storage, call.recording.fileKey);
    await CallModel.updateMany(
      { _id: { $in: batch.map((c) => c._id) } },
      { $set: { 'recording.deletedAt': now } },
    );
    deleted += batch.length;
  }
};

/**
 * `calls-purge` (daily): per account first (its own shorter retention, Phase 14), then
 * everything older than the platform default (`CALL_RETENTION_DAYS`) — no account keeps
 * longer than that. Recordings of accounts that keep them for less than their calls
 * lose only the file. Batched and resumable; logs counts only.
 */
export const purgeCalls = async (
  storage: StorageProvider | undefined,
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ calls: number; recordings: number }> => {
  const before = (days: number) => ({ $lt: new Date(now.getTime() - days * DAY_MS) });
  const platform = { callsDays: retentionDays, inboxDays: null };
  const custom = await AccountModel.find({
    $or: [
      { 'retention.callsDays': { $ne: null } },
      { 'retention.recordingsDays': { $ne: null } },
      { 'retentionCap.callsDays': { $ne: null } },
    ],
  })
    .select({ retention: 1, retentionCap: 1 })
    .lean<Pick<AccountDoc, '_id' | 'retention' | 'retentionCap'>[]>();
  let calls = 0;
  let recordings = 0;
  for (const account of custom) {
    const days = effectiveRetention(account, platform);
    calls += await deleteCalls(storage, {
      accountId: account._id,
      createdAt: before(days.callsDays),
    });
    if (days.recordingsDays < days.callsDays)
      recordings += await deleteRecordings(
        storage,
        { accountId: account._id, createdAt: before(days.recordingsDays) },
        now,
      );
  }
  calls += await deleteCalls(storage, { createdAt: before(retentionDays) });
  return { calls, recordings };
};
