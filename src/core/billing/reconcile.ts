import type { Types } from 'mongoose';

import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import { notifyPlatform } from '../../modules/notifications/notifications.service';
import { getLogger } from '../../shared/logger';

interface Sums {
  _id: Types.ObjectId;
  credits: number;
  debits: number;
  held: number;
}

export interface ReconcileMismatch {
  accountId: string;
  field: 'balanceMicros' | 'holdMicros';
  expected: number;
  actual: number;
}

/**
 * Daily check that every wallet equals its ledger (PHASE_4_PLAN §1f):
 * balance = Σ captured credits − Σ captured debits, hold = Σ held.
 * Mismatches are logged and reported to superadmins — never auto-fixed.
 */
export const reconcileWallets = async (): Promise<{
  checked: number;
  mismatches: ReconcileMismatch[];
}> => {
  const sums = await LedgerEntryModel.aggregate<Sums>([
    {
      $group: {
        _id: '$accountId',
        credits: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$status', 'captured'] }, { $eq: ['$direction', 'credit'] }] },
              '$amountMicros',
              0,
            ],
          },
        },
        debits: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$status', 'captured'] }, { $eq: ['$direction', 'debit'] }] },
              '$amountMicros',
              0,
            ],
          },
        },
        held: { $sum: { $cond: [{ $eq: ['$status', 'held'] }, '$amountMicros', 0] } },
      },
    },
  ]);
  const byAccount = new Map(sums.map((s) => [s._id.toString(), s]));
  const mismatches: ReconcileMismatch[] = [];
  let checked = 0;
  const cursor = WalletModel.find({})
    .select({ accountId: 1, balanceMicros: 1, holdMicros: 1 })
    .lean<WalletDoc[]>()
    .cursor({ batchSize: 500 });
  for await (const raw of cursor) {
    const w = raw;
    checked += 1;
    const s = byAccount.get(w.accountId.toString());
    const balance = (s?.credits ?? 0) - (s?.debits ?? 0);
    const hold = s?.held ?? 0;
    if (w.balanceMicros !== balance) {
      mismatches.push({
        accountId: w.accountId.toString(),
        field: 'balanceMicros',
        expected: balance,
        actual: w.balanceMicros,
      });
    }
    if (w.holdMicros !== hold) {
      mismatches.push({
        accountId: w.accountId.toString(),
        field: 'holdMicros',
        expected: hold,
        actual: w.holdMicros,
      });
    }
  }
  for (const m of mismatches) getLogger().error(m, 'billing: wallet does not match its ledger');
  if (mismatches.length) {
    await notifyPlatform({
      type: 'billing.reconcile_mismatch',
      title: 'Wallet reconciliation found differences',
      body: `${mismatches.length} difference(s) between wallets and the ledger — see the server log (billing: wallet does not match its ledger).`,
      link: '/admin/billing',
    });
  }
  return { checked, mismatches };
};
