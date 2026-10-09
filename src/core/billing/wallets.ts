import type { ClientSession, Types } from 'mongoose';

import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import { getLogger } from '../../shared/logger';

/** Creates the wallet of a new account (signup transaction, migration 0005). */
export const createWallet = async (
  accountId: Types.ObjectId,
  session?: ClientSession,
): Promise<void> => {
  await WalletModel.create([{ accountId }], session ? { session } : {});
};

/**
 * The account's wallet. Every account gets one at signup (or migration 0005);
 * the upsert is a safety net and logs a warning when it had to create one.
 */
export const getOrCreateWallet = async (accountId: Types.ObjectId): Promise<WalletDoc> => {
  const found = await WalletModel.findOne({ accountId }).lean<WalletDoc>();
  if (found) return found;
  const created = await WalletModel.findOneAndUpdate(
    { accountId },
    { $setOnInsert: { accountId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean<WalletDoc>();
  getLogger().warn({ accountId: accountId.toString() }, 'wallet: created missing wallet');
  if (!created) throw new Error('wallet upsert returned nothing');
  return created;
};

export interface WalletSettingsInput {
  lowBalanceThresholdMicros?: number;
  budgets?: { monthlyCallMicros?: number; monthlyAiMicros?: number };
}

/**
 * Threshold / budgets (not money — no ledger row). A new threshold re-arms
 * the low-balance alert.
 */
export const updateWalletSettings = async (
  accountId: Types.ObjectId,
  input: WalletSettingsInput,
): Promise<{ before: WalletDoc; after: WalletDoc }> => {
  const before = await getOrCreateWallet(accountId);
  const set: Record<string, unknown> = {};
  if (input.lowBalanceThresholdMicros !== undefined) {
    set.lowBalanceThresholdMicros = input.lowBalanceThresholdMicros;
    set['alerts.lowBalanceNotifiedAt'] = null;
  }
  if (input.budgets?.monthlyCallMicros !== undefined)
    set['budgets.monthlyCallMicros'] = input.budgets.monthlyCallMicros;
  if (input.budgets?.monthlyAiMicros !== undefined)
    set['budgets.monthlyAiMicros'] = input.budgets.monthlyAiMicros;
  const after = await WalletModel.findOneAndUpdate(
    { accountId },
    { $set: set, $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).lean<WalletDoc>();
  if (!after) throw new Error('wallet disappeared');
  return { before, after };
};
