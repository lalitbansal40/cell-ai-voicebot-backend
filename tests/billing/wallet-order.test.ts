import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { credit } from '../../src/core/billing/engine';
import { createWallet } from '../../src/core/billing/wallets';
import { WalletModel } from '../../src/db/models/wallet.model';
import { useTestDb } from '../helpers/db';

useTestDb();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wallet changes in one process', () => {
  it('parallel changes to one wallet run in order, with no transaction retries', async () => {
    const accountId = new Types.ObjectId();
    await createWallet(accountId);
    const writes = vi.spyOn(WalletModel, 'findOneAndUpdate');
    const count = 30;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        credit({
          accountId,
          type: 'adjustment',
          amountMicros: 1_000_000,
          ref: { type: 'manual', id: String(i) },
          idempotencyKey: `order-${String(i)}`,
        }),
      ),
    );
    expect(writes).toHaveBeenCalledTimes(count);
    const wallet = await WalletModel.findOne({ accountId }).lean();
    expect(wallet?.balanceMicros).toBe(count * 1_000_000);
  });
});
