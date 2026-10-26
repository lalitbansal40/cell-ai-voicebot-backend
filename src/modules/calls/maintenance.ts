import { CALL_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { AnalyticsMarkModel, analyticsMarkId } from '../../db/models/analytics-mark.model';
import { CallEventModel } from '../../db/models/call-event.model';
import { CallInsightModel } from '../../db/models/call-insight.model';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import { FlowRunModel } from '../../db/models/flow-run.model';
import { TranscriptTurnModel } from '../../db/models/transcript-turn.model';
import type { Logger } from '../../shared/logger';

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

/** Calls older than the retention: recording file, events, transcript, insights, call-mode run, call. */
export const purgeCalls = async (
  storage: StorageProvider | undefined,
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ calls: number }> => {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const old = await CallModel.find({ createdAt: { $lt: cutoff } })
    .select({ recording: 1, flowRunId: 1 })
    .lean<Pick<CallDoc, '_id' | 'recording' | 'flowRunId'>[]>();
  for (const call of old) {
    if (call.recording && storage) await storage.delete(call.recording.fileKey);
    await CallEventModel.deleteMany({ callId: call._id });
    await TranscriptTurnModel.deleteMany({ callId: call._id });
    await CallInsightModel.deleteMany({ callId: call._id });
    if (call.flowRunId) await FlowRunModel.deleteOne({ _id: call.flowRunId, mode: 'call' });
    await CallModel.deleteOne({ _id: call._id });
    // its counts stay in the report rollups; only the bookkeeping goes
    await AnalyticsMarkModel.deleteOne({ _id: analyticsMarkId('call', call._id) });
  }
  return { calls: old.length };
};
