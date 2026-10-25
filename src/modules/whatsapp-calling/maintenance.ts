import type { Types } from 'mongoose';

import { CALL_LIMITS, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { releaseWhatsAppCallHold } from '../../core/billing/engine';
import { pulsesFor } from '../../core/billing/whatsapp-calls';
import { CallModel, LIVE_CALL_STATUSES, type CallDoc } from '../../db/models/call.model';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { getLogger } from '../../shared/logger';

const BATCH = 500;

/**
 * `billing.whatsapp_call_reap_holds` (every 15 min): a WhatsApp call hold still held
 * after the longest possible call + the late-terminate grace belongs to a call whose
 * process died before settling → released (`stale`), the call marked `released`.
 * The Phase 4 / Phase 11 reapers never touch these rows (they filter their own types).
 * Idempotent.
 */
export const reapWhatsAppCallHolds = async (now = new Date()): Promise<{ released: number }> => {
  const ageMs =
    (CALL_LIMITS.maxCallSecHard + WHATSAPP_CALL_LIMITS.lateTerminateGraceSec) * 1000 + 30 * 60_000;
  const roots = await LedgerEntryModel.find({
    type: 'whatsapp_call_charge',
    status: 'held',
    holdId: null,
    createdAt: { $lt: new Date(now.getTime() - ageMs) },
  })
    .select({ accountId: 1, ref: 1 })
    .limit(BATCH)
    .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId; ref: { id: string } }[]>();
  let released = 0;
  for (const root of roots) {
    try {
      const res = await releaseWhatsAppCallHold({
        accountId: root.accountId,
        holdId: root._id,
        reason: 'stale',
      });
      if (res.replay) continue;
      released += 1;
      await CallModel.updateOne(
        { _id: root.ref.id, accountId: root.accountId, 'billing.whatsapp.status': 'held' },
        { $set: { 'billing.whatsapp.status': 'released' } },
      );
      getLogger().warn(
        { accountId: root.accountId.toString(), holdId: root._id.toString() },
        'billing: released a stale whatsapp call hold',
      );
    } catch (err) {
      getLogger().error(
        { errName: (err as Error).name, holdId: root._id.toString() },
        'billing: whatsapp call hold release failed',
      );
    }
  }
  return { released };
};

/**
 * `billing.whatsapp_call_reconcile` (hourly): calls charged on our measured time whose
 * Meta `duration` arrived later get Meta's pulses stored beside ours (`metaLatePulses`)
 * for the margin report. The customer's charge stays as billed — no money moves.
 */
export const reconcileWhatsAppCalls = async (): Promise<{
  checked: number;
  mismatches: number;
}> => {
  const rows = await CallModel.find({
    provider: 'whatsapp',
    status: { $nin: [...LIVE_CALL_STATUSES] },
    'billing.whatsapp.durationSource': 'ours',
    'billing.whatsapp.metaLatePulses': null,
    'whatsapp.metaDuration': { $ne: null },
  })
    .select({ billing: 1, whatsapp: 1 })
    .limit(BATCH)
    .lean<CallDoc[]>();
  let mismatches = 0;
  for (const c of rows) {
    const meta = pulsesFor(c.whatsapp?.metaDuration ?? 0);
    if (meta !== c.billing.whatsapp?.pulses) mismatches += 1;
    await CallModel.updateOne(
      { _id: c._id, 'billing.whatsapp.metaLatePulses': null },
      { $set: { 'billing.whatsapp.metaLatePulses': meta } },
    );
  }
  return { checked: rows.length, mismatches };
};
