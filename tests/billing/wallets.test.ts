import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { createWallet, getOrCreateWallet } from '../../src/core/billing/wallets';
import { WalletModel } from '../../src/db/models/wallet.model';
import * as loggerModule from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';

useTestDb();

describe('wallet store', () => {
  it('creates a wallet and returns it', async () => {
    const accountId = new Types.ObjectId();
    await createWallet(accountId);
    const wallet = await getOrCreateWallet(accountId);
    expect(wallet).toMatchObject({ balanceMicros: 0, holdMicros: 0 });
  });

  it('creates a missing wallet as a safety net and warns', async () => {
    const warn = vi.fn();
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue({ warn } as never);
    const accountId = new Types.ObjectId();
    const wallet = await getOrCreateWallet(accountId);
    expect(wallet.lowBalanceThresholdMicros).toBe(500_000_000);
    expect(warn).toHaveBeenCalledWith(
      { accountId: accountId.toString() },
      'wallet: created missing wallet',
    );
    expect(await WalletModel.countDocuments({ accountId })).toBe(1);
    vi.restoreAllMocks();
  });
});
