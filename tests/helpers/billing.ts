import type { Types } from 'mongoose';
import { expect } from 'vitest';

import type { BillingJobData, BillingJobName, BillingJobs } from '../../src/core/billing/jobs';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { WalletModel } from '../../src/db/models/wallet.model';

/** Billing jobs that are recorded instead of queued (tests). */
export const recordingBillingJobs = () => {
  const queued: { name: BillingJobName; data: BillingJobData[BillingJobName] }[] = [];
  const jobs: BillingJobs = {
    enqueue(name, data) {
      queued.push({ name, data });
      return Promise.resolve();
    },
  };
  return { jobs, queued };
};

/**
 * Wallet ↔ ledger invariants (PHASE_11_PROMPT rule 6): the sum of held rows equals
 * `holdMicros`, and the balance equals captured credits − captured debits.
 */
export const expectWalletConsistent = async (accountId: Types.ObjectId): Promise<void> => {
  const [wallet, rows] = await Promise.all([
    WalletModel.findOne({ accountId }).lean(),
    LedgerEntryModel.find({ accountId }).lean(),
  ]);
  if (!wallet) throw new Error('no wallet');
  const sum = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(f).reduce((s, r) => s + r.amountMicros, 0);
  expect(wallet.holdMicros).toBe(sum((r) => r.status === 'held'));
  expect(wallet.balanceMicros).toBe(
    sum((r) => r.status === 'captured' && r.direction === 'credit') -
      sum((r) => r.status === 'captured' && r.direction === 'debit'),
  );
};
