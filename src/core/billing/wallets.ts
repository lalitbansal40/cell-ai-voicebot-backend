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
