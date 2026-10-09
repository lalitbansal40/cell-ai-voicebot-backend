import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { AccountModel } from '../../src/db/models/account.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0005-wallets');
  if (!found) throw new Error('0005 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0005-wallets', () => {
  it('is registered right after 0004', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0005-wallets')).toBe(names.indexOf('0004-dnd-manage-permission') + 1);
  });

  it('creates wallets for customer accounts and the default rate card; idempotent', async () => {
    const a = await AccountModel.create({ name: 'Old A', slug: 'old-a-p4' });
    const b = await AccountModel.create({ name: 'Old B', slug: 'old-b-p4' });
    const platform = await AccountModel.create({
      name: 'Platform',
      slug: 'platform-p4',
      isPlatform: true,
    });
    await WalletModel.create({ accountId: b._id, balanceMicros: 5_000_000 }); // already there
    await migration().up(db());
    await migration().up(db());

    expect(await WalletModel.countDocuments({ accountId: platform._id })).toBe(0);
    const wa = await WalletModel.findOne({ accountId: a._id }).lean();
    expect(wa).toMatchObject({ balanceMicros: 0, lowBalanceThresholdMicros: 500_000_000 });
    expect((await WalletModel.findOne({ accountId: b._id }).lean())?.balanceMicros).toBe(5_000_000);
    const defaults = await RateCardModel.find({ accountId: null }).lean();
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      callPerMinuteMicros: 1_000_000,
      pulseSeconds: 60,
      aiPerMinuteMicros: 6_000_000,
      ttsPer1kCharsMicros: 2_500_000,
      commissionBps: 0,
      billUnansweredAttempts: false,
    });
    expect(await collections()).toEqual(
      expect.arrayContaining(['invoiceCounters', 'paymentEvents', 'notifications']),
    );
  });

  it('refuses to roll back once money moved; rolls back when the ledger is empty', async () => {
    await migration().up(db());
    const row = await LedgerEntryModel.create({
      accountId: new mongoose.Types.ObjectId(),
      type: 'topup',
      direction: 'credit',
      status: 'captured',
      amountMicros: 1_000_000,
      ref: { type: 'manual', id: 'x' },
      idempotencyKey: 'down-test',
    });
    await expect(migration().down(db())).rejects.toThrow(/refusing to roll back/);
    await db().collection('ledgerEntries').deleteOne({ _id: row._id }); // driver bypasses the guard
    await migration().down(db());
    expect(await WalletModel.countDocuments({})).toBe(0);
    expect(await RateCardModel.countDocuments({})).toBe(0);
    expect(await collections()).not.toContain('invoiceCounters');
    await migration().down(db()); // nothing left to drop — still fine
  });
});
