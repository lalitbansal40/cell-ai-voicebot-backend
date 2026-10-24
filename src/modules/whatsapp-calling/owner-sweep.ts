import { WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { CallModel, LIVE_CALL_STATUSES, type CallDoc } from '../../db/models/call.model';
import type { Logger } from '../../shared/logger';

import type { CallControlBus } from './bus';

/**
 * Owner loss (PHASE_12_PROMPT T12.4): a WhatsApp call whose owning process stopped
 * refreshing `call:wa:owner:<waCallId>` for `ownerTtlSec` has no media any more.
 * A surviving process marks it `failed` / `server_shutdown` (only from a live
 * status — a racing end wins) and asks Meta to terminate it, so Meta stops billing.
 * Money is settled by the call billing (T12.7) from the final call.
 */
export interface OwnerSweepDeps {
  bus: Pick<CallControlBus, 'ownerOf'>;
  /** Graph terminate for the call's number (errors are logged, never thrown). */
  terminate: (call: CallDoc) => Promise<void>;
  logger: Logger;
  now?: Date;
}

export const sweepOrphanedWhatsAppCalls = async (
  deps: OwnerSweepDeps,
): Promise<{ failed: number }> => {
  const now = deps.now ?? new Date();
  const stale = new Date(now.getTime() - WHATSAPP_CALL_LIMITS.ownerTtlSec * 1000);
  const candidates = await CallModel.find({
    provider: 'whatsapp',
    status: { $in: [...LIVE_CALL_STATUSES] },
    'whatsapp.waCallId': { $type: 'string' },
    updatedAt: { $lt: stale },
  })
    .limit(500)
    .lean<CallDoc[]>();
  let failed = 0;
  for (const call of candidates) {
    const waCallId = call.whatsapp?.waCallId;
    if (!waCallId || (await deps.bus.ownerOf(waCallId))) continue;
    const answeredAt = call.timestamps.answeredAt;
    const res = await CallModel.updateOne(
      { _id: call._id, status: call.status },
      {
        $set: {
          status: 'failed',
          endReason: 'server_shutdown',
          durationSec: answeredAt
            ? Math.max(0, Math.round((call.updatedAt.getTime() - answeredAt.getTime()) / 1000))
            : 0,
          'timestamps.endedAt': now,
          error: { code: 'server_shutdown' },
        },
        $push: { 'whatsapp.timeline': { event: 'owner_lost', at: now } },
      },
    );
    if (res.modifiedCount !== 1) continue;
    failed += 1;
    await deps.terminate(call).catch((err: unknown) => {
      deps.logger.warn(
        { callId: call._id.toString(), errName: (err as Error).name },
        'whatsapp calls: terminate after owner loss failed',
      );
    });
  }
  return { failed };
};
