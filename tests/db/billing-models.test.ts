import type mongoose from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { InvoiceCounterModel } from '../../src/db/models/invoice-counter.model';
import { InvoiceModel } from '../../src/db/models/invoice.model';
import { LedgerEntryModel, LedgerImmutableError } from '../../src/db/models/ledger-entry.model';
import { NotificationModel, NOTIFICATION_TTL_MS } from '../../src/db/models/notification.model';
import { PaymentEventModel, PAYMENT_EVENT_TTL_MS } from '../../src/db/models/payment-event.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { TopupOrderModel } from '../../src/db/models/topup-order.model';
import {
  DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
  WalletModel,
} from '../../src/db/models/wallet.model';
import { useTestDb } from '../helpers/db';

useTestDb();

interface IndexInfo {
  key: Record<string, number>;
  unique: boolean;
  partial?: Record<string, unknown>;
  ttl?: number;
}
const indexes = async (model: mongoose.Model<never>): Promise<IndexInfo[]> =>
  (await model.collection.listIndexes().toArray()).map((i) => ({
    key: i.key as Record<string, number>,
    unique: Boolean(i.unique),
    partial: i.partialFilterExpression as Record<string, unknown> | undefined,
    ttl: i.expireAfterSeconds as number | undefined,
  }));
const find = async (model: mongoose.Model<never>, key: Record<string, number>) =>
  (await indexes(model)).find((i) => JSON.stringify(i.key) === JSON.stringify(key));

const BUYER = {
  legalName: 'Test Finance Pvt Ltd',
  email: 'billing@example.com',
  addressLine1: '1 Test Road',
  city: 'Jaipur',
  stateCode: '08',
  pin: '302001',
};
const id = () => new Types.ObjectId();
const ledgerRow = (accountId: Types.ObjectId, extra: Record<string, unknown> = {}) =>
  LedgerEntryModel.create({
    accountId,
    type: 'call_charge',
    direction: 'debit',
    status: 'held',
    amountMicros: 6_000_000,
    ref: { type: 'simulator', id: 'sim-1' },
    idempotencyKey: `hold:simulator:${new Types.ObjectId().toString()}`,
    ...extra,
  });

describe('Wallet', () => {
  it('has defaults, hides internals and one wallet per account', async () => {
    const accountId = id();
    const wallet = await WalletModel.create({ accountId });
    expect(wallet.toObject()).toMatchObject({
      currency: 'INR',
      balanceMicros: 0,
      holdMicros: 0,
      creditLimitMicros: 0,
      lowBalanceThresholdMicros: DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
      budgets: { monthlyCallMicros: 0, monthlyAiMicros: 0 },
      spend: { month: null, callMicros: 0, aiMicros: 0, ttsMicros: 0 },
    });
    const json = wallet.toJSON() as unknown as Record<string, unknown>;
    expect(json).not.toHaveProperty('alerts');
    expect(json).not.toHaveProperty('version');
    await expect(WalletModel.create({ accountId })).rejects.toMatchObject({ code: 11000 });
    expect(await find(WalletModel as never, { accountId: 1 })).toMatchObject({ unique: true });
  });

  it('accepts a negative balance but rejects fractions and negative holds', async () => {
    await expect(WalletModel.create({ accountId: id(), balanceMicros: -5 })).resolves.toBeTruthy();
    await expect(WalletModel.create({ accountId: id(), balanceMicros: 1.5 })).rejects.toThrow(
      /whole number/,
    );
    await expect(WalletModel.create({ accountId: id(), holdMicros: -1 })).rejects.toThrow();
  });
});

describe('LedgerEntry', () => {
  it('validates amounts and hides the idempotency key', async () => {
    const row = await ledgerRow(id());
    expect((row.toJSON() as unknown as Record<string, unknown>).idempotencyKey).toBeUndefined();
    await expect(ledgerRow(id(), { amountMicros: 0 })).rejects.toThrow(/positive/);
    await expect(ledgerRow(id(), { amountMicros: 1.2 })).rejects.toThrow(/positive/);
    await expect(ledgerRow(id(), { balanceAfterMicros: 0.5 })).rejects.toThrow();
    await expect(ledgerRow(id(), { type: 'nope' })).rejects.toThrow();
  });

  it('has the planned indexes (idempotency unique per account)', async () => {
    const model = LedgerEntryModel as never;
    expect(await find(model, { accountId: 1, idempotencyKey: 1 })).toMatchObject({ unique: true });
    expect(await find(model, { accountId: 1, createdAt: -1, _id: -1 })).toBeTruthy();
    expect(await find(model, { accountId: 1, 'ref.type': 1, 'ref.id': 1 })).toBeTruthy();
    expect(await find(model, { status: 1, createdAt: 1 })).toBeTruthy();
    expect(await find(model, { holdId: 1 })).toBeTruthy();
    const accountId = id();
    await ledgerRow(accountId, { idempotencyKey: 'k1' });
    await expect(ledgerRow(accountId, { idempotencyKey: 'k1' })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(ledgerRow(id(), { idempotencyKey: 'k1' })).resolves.toBeTruthy();
  });

  it('is insert-only: only held → released with the release option', async () => {
    const row = await ledgerRow(id());
    const release = { $set: { status: 'released', releasedAt: new Date(), releaseReason: 'x' } };
    await expect(
      LedgerEntryModel.updateOne({ _id: row._id, status: 'held' }, release),
    ).rejects.toThrow(LedgerImmutableError);
    await expect(
      LedgerEntryModel.updateOne({ _id: row._id, status: 'held' }, { $set: { amountMicros: 1 } }, {
        ledgerRelease: true,
      } as never),
    ).rejects.toThrow(LedgerImmutableError);
    await expect(
      LedgerEntryModel.updateOne({ _id: row._id }, release, { ledgerRelease: true } as never),
    ).rejects.toThrow(LedgerImmutableError);
    await expect(
      LedgerEntryModel.updateOne(
        { _id: row._id, status: 'held' },
        { $set: { status: 'captured' } },
        { ledgerRelease: true } as never,
      ),
    ).rejects.toThrow(LedgerImmutableError);
    await expect(
      LedgerEntryModel.updateOne({ _id: row._id, status: 'held' }, { $inc: { amountMicros: 1 } }, {
        ledgerRelease: true,
      } as never),
    ).rejects.toThrow(LedgerImmutableError);
    const ok = await LedgerEntryModel.updateMany({ _id: row._id, status: 'held' }, release, {
      ledgerRelease: true,
    } as never);
    expect(ok.modifiedCount).toBe(1);
    expect((await LedgerEntryModel.findById(row._id).lean())?.status).toBe('released');
    await expect(
      LedgerEntryModel.findOneAndUpdate({ _id: row._id, status: 'held' }, release),
    ).rejects.toThrow(LedgerImmutableError);
  });

  it('blocks deletes, replaces and re-saves', async () => {
    const row = await ledgerRow(id());
    await expect(LedgerEntryModel.deleteOne({ _id: row._id })).rejects.toThrow(
      LedgerImmutableError,
    );
    await expect(LedgerEntryModel.deleteMany({})).rejects.toThrow(LedgerImmutableError);
    await expect(LedgerEntryModel.findOneAndDelete({ _id: row._id })).rejects.toThrow(
      LedgerImmutableError,
    );
    await expect(LedgerEntryModel.replaceOne({ _id: row._id }, {})).rejects.toThrow(
      LedgerImmutableError,
    );
    await expect(LedgerEntryModel.findOneAndReplace({ _id: row._id }, {})).rejects.toThrow(
      LedgerImmutableError,
    );
    row.note = 'changed';
    await expect(row.save()).rejects.toThrow(LedgerImmutableError);
  });

  it('lets only the dev benchmark delete (never in production)', async () => {
    const accountId = id();
    await ledgerRow(accountId);
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await expect(
        LedgerEntryModel.deleteMany({ accountId }, { allowLedgerDelete: true }),
      ).rejects.toThrow(LedgerImmutableError);
    } finally {
      process.env.NODE_ENV = before;
    }
    const res = await LedgerEntryModel.deleteMany(
      { accountId },
      {
        allowLedgerDelete: true,
      },
    );
    expect(res.deletedCount).toBe(1);
  });
});

describe('RateCard, TopupOrder, Invoice, counters, events, notifications', () => {
  it('rate cards: platform default allowed (accountId null), pulse enum, bps range', async () => {
    const card = await RateCardModel.create({ ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
    expect(card.accountId).toBeNull();
    expect(card.inheritsDefault).toBe(false);
    await expect(
      RateCardModel.create({
        ...DEFAULT_RATE_CARD,
        pulseSeconds: 20 as never,
        effectiveFrom: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      RateCardModel.create({
        ...DEFAULT_RATE_CARD,
        commissionBps: 10_001,
        effectiveFrom: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      RateCardModel.create({
        ...DEFAULT_RATE_CARD,
        callPerMinuteMicros: 0.5,
        effectiveFrom: new Date(),
      }),
    ).rejects.toThrow(/micros/);
    expect(await find(RateCardModel as never, { accountId: 1, effectiveFrom: -1 })).toBeTruthy();
  });

  it('top-up orders: partial unique provider ids, hidden raw status', async () => {
    const base = {
      provider: 'fake' as const,
      baseMicros: 1_000_000_000,
      taxMicros: 180_000_000,
      totalMicros: 1_180_000_000,
      buyer: BUYER,
      createdBy: id(),
    };
    const a = await TopupOrderModel.create({ ...base, accountId: id(), rawProviderStatus: 'x' });
    await TopupOrderModel.create({ ...base, accountId: id() }); // two null provider ids OK
    expect(a.status).toBe('creating');
    expect((a.toJSON() as unknown as Record<string, unknown>).rawProviderStatus).toBeUndefined();
    await TopupOrderModel.create({ ...base, accountId: id(), providerOrderId: 'order_1' });
    await expect(
      TopupOrderModel.create({ ...base, accountId: id(), providerOrderId: 'order_1' }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      TopupOrderModel.create({ ...base, accountId: id(), baseMicros: 0 }),
    ).rejects.toThrow();
    expect(
      await find(TopupOrderModel as never, { provider: 1, providerPaymentId: 1 }),
    ).toMatchObject({ unique: true, partial: { providerPaymentId: { $type: 'string' } } });
  });

  it('invoices: unique number and order, hidden file key', async () => {
    const doc = {
      accountId: id(),
      number: 'CAV/26-27/000001',
      fy: '26-27',
      topupOrderId: id(),
      ledgerEntryId: id(),
      seller: { name: 'S', address: 'A', gstin: null, stateCode: '08' },
      buyer: BUYER,
      placeOfSupply: { stateCode: '08', stateName: 'Rajasthan' },
      sacCode: '998319',
      amounts: {
        baseMicros: 1,
        cgstMicros: 0,
        sgstMicros: 0,
        igstMicros: 0,
        taxMicros: 0,
        totalMicros: 1,
      },
      paymentId: 'pay_1',
      issuedAt: new Date(),
      pdfFileKey: 'k',
    };
    const inv = await InvoiceModel.create(doc);
    expect(inv.status).toBe('rendering');
    expect((inv.toJSON() as unknown as Record<string, unknown>).pdfFileKey).toBeUndefined();
    await expect(InvoiceModel.create({ ...doc, topupOrderId: id() })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(InvoiceModel.create({ ...doc, number: 'CAV/26-27/000002' })).rejects.toMatchObject(
      { code: 11000 },
    );
    await expect(InvoiceModel.create({ ...doc, number: 'X'.repeat(17) })).rejects.toThrow();
  });

  it('invoice counters increment atomically per financial year', async () => {
    const next = () =>
      InvoiceCounterModel.findOneAndUpdate(
        { _id: '26-27' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
    const seqs = (await Promise.all(Array.from({ length: 10 }, next))).map((c) => c?.seq);
    expect(new Set(seqs).size).toBe(10);
  });

  it('payment events and notifications expire after 90 days', async () => {
    expect(PAYMENT_EVENT_TTL_MS).toBe(90 * 86_400_000);
    expect(NOTIFICATION_TTL_MS).toBe(90 * 86_400_000);
    expect(await find(PaymentEventModel as never, { expiresAt: 1 })).toMatchObject({ ttl: 0 });
    expect(await find(PaymentEventModel as never, { provider: 1, eventId: 1 })).toMatchObject({
      unique: true,
    });
    expect(await find(NotificationModel as never, { expiresAt: 1 })).toMatchObject({ ttl: 0 });
    expect(
      await find(NotificationModel as never, { accountId: 1, userId: 1, readAt: 1, createdAt: -1 }),
    ).toBeTruthy();
    const n = await NotificationModel.create({
      accountId: id(),
      userId: id(),
      type: 'wallet.low_balance',
      title: 'Low balance',
      body: 'Add money',
      expiresAt: new Date(Date.now() + NOTIFICATION_TTL_MS),
    });
    expect(n.readAt).toBeNull();
    expect((n.toJSON() as unknown as Record<string, unknown>).expiresAt).toBeUndefined();
  });

  it('accounts carry an optional billing profile', async () => {
    const account = await AccountModel.create({
      name: 'Billing Co',
      slug: 'billing-co',
      billing: { ...BUYER, gstin: null, updatedAt: new Date() },
    });
    expect(account.billing).toMatchObject({ legalName: 'Test Finance Pvt Ltd', stateCode: '08' });
    expect((await AccountModel.create({ name: 'Plain', slug: 'plain-co' })).billing).toBeNull();
    await expect(
      AccountModel.create({
        name: 'Bad',
        slug: 'bad-billing',
        billing: { ...BUYER, pin: '1', updatedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});
