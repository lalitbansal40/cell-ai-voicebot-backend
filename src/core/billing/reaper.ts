import type { Types } from 'mongoose';

import { BILLING_LIMITS } from '../../config/limits';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { getLogger } from '../../shared/logger';

import { releaseHold } from './engine';

const BATCH = 1000;

/**
 * Releases holds older than 2 h (a call that crashed without settling).
 * Phase 7 replaces this with call-state checks. Idempotent.
 */
export const reapStaleHolds = async (now = new Date()): Promise<{ released: number }> => {
  const cutoff = new Date(now.getTime() - BILLING_LIMITS.staleHoldMs);
  const rows = await LedgerEntryModel.find({ status: 'held', createdAt: { $lt: cutoff } })
    .select({ accountId: 1, holdId: 1 })
    .limit(BATCH)
    .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId; holdId?: Types.ObjectId | null }[]>();
  const roots = new Map<string, { accountId: Types.ObjectId; holdId: Types.ObjectId }>();
  for (const r of rows) {
    const holdId = r.holdId ?? r._id;
    roots.set(holdId.toString(), { accountId: r.accountId, holdId });
  }
  let released = 0;
  for (const { accountId, holdId } of roots.values()) {
    try {
      const res = await releaseHold({ accountId, holdId, reason: 'stale' });
      if (!res.replay) {
        released += 1;
        getLogger().warn(
          { accountId: accountId.toString(), holdId: holdId.toString() },
          'billing: released a stale hold',
        );
      }
    } catch (err) {
      getLogger().error({ err, holdId: holdId.toString() }, 'billing: stale hold release failed');
    }
  }
  return { released };
};
