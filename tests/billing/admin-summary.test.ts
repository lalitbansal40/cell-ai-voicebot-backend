import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { NotificationModel } from '../../src/db/models/notification.model';
import { PAYMENT_EVENT_TTL_MS, PaymentEventModel } from '../../src/db/models/payment-event.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const RUPEE = 1_000_000;
const get = (url: string) =>
  request(app)
    .get(url)
    .set({ Authorization: `Bearer ${superadmin.token}` });

let platform: TestAccount;
let superadmin: TestUser;
let a: TestAccount;
let b: TestAccount;
let c: TestAccount;

/** Raw inserts: the fixture needs fixed timestamps (the app never back-dates rows). */
const col = (name: string) => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db');
  return db.collection(name);
};

// IST month 2025-03 = 2025-02-28T18:30Z … 2025-03-31T18:30Z
const IN = new Date('2025-03-10T10:00:00Z');
const FIRST_IST = new Date('2025-02-28T19:00:00Z'); // 1 Mar 00:30 IST — inside
const LAST_UTC = new Date('2025-03-31T19:00:00Z'); // 1 Apr 00:30 IST — outside
const BEFORE = new Date('2025-02-28T18:00:00Z'); // 28 Feb 23:30 IST — outside

const ledger = (
  accountId: Types.ObjectId,
  type: string,
  amountMicros: number,
  createdAt: Date,
  extra: Record<string, unknown> = {},
) => ({
  _id: new Types.ObjectId(),
  accountId,
  type,
  direction: 'debit',
  status: 'captured',
  amountMicros,
  currency: 'INR',
  ref: { type: 'call', id: new Types.ObjectId().toString() },
  idempotencyKey: `fx:${new Types.ObjectId().toString()}`,
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

const order = (
  accountId: Types.ObjectId,
  status: string,
  baseRupees: number,
  at: Date,
  intra: boolean,
) => {
  const base = baseRupees * RUPEE;
  const tax = (base * 18) / 100;
  return {
    _id: new Types.ObjectId(),
    accountId,
    provider: 'fake',
    providerOrderId: `order_${new Types.ObjectId().toString()}`,
    providerPaymentId: status === 'paid' ? `pay_${new Types.ObjectId().toString()}` : null,
    currency: 'INR',
    status,
    baseMicros: base,
    cgstMicros: intra ? tax / 2 : 0,
    sgstMicros: intra ? tax / 2 : 0,
    igstMicros: intra ? 0 : tax,
    taxMicros: tax,
    totalMicros: base + tax,
    buyer: {
      legalName: 'X',
      email: 'x@example.com',
      addressLine1: 'a',
      city: 'c',
      stateCode: '08',
      pin: '302001',
    },
    createdBy: new Types.ObjectId(),
    paidAt: status === 'paid' ? at : null,
    createdAt: at,
    updatedAt: at,
  };
};

beforeAll(async () => {
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-${Date.now()}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  a = await createTestAccount({ name: 'Alpha Loans' });
  b = await createTestAccount({ name: 'Beta Credit' });
  c = await createTestAccount({ name: 'Gamma Finance' });
  const [A, B, C] = [a.account._id, b.account._id, c.account._id];

  await col('ledgerEntries').insertMany([
    ledger(A, 'call_charge', 30 * RUPEE, IN),
    ledger(A, 'ai_charge', 5 * RUPEE, FIRST_IST),
    ledger(B, 'call_charge', 50 * RUPEE, IN),
    ledger(B, 'tts_charge', 2 * RUPEE, IN),
    ledger(C, 'call_charge', 1 * RUPEE, IN),
    // not usage / not in the month / not captured
    ledger(C, 'call_charge', 999 * RUPEE, LAST_UTC),
    ledger(C, 'call_charge', 999 * RUPEE, BEFORE),
    ledger(C, 'call_charge', 999 * RUPEE, IN, { status: 'held' }),
    ledger(A, 'adjustment', 100 * RUPEE, IN, { direction: 'credit' }),
    ledger(A, 'adjustment', 7 * RUPEE, IN),
    ledger(A, 'topup', 1000 * RUPEE, IN, { direction: 'credit' }),
  ]);
  await col('topupOrders').insertMany([
    order(A, 'paid', 1000, IN, true),
    order(B, 'paid', 500, FIRST_IST, false),
    order(B, 'paid', 700, LAST_UTC, false),
    order(C, 'failed', 300, IN, false),
    order(C, 'created', 200, IN, false),
  ]);
  const events = [
    ['evt_1', 'credited', IN],
    ['evt_2', 'unmatched', IN],
    ['evt_3', 'mismatch', IN],
    ['evt_4', 'refund', BEFORE],
    ['evt_5', 'ignored', IN],
  ] as const;
  for (const [eventId, outcome, receivedAt] of events) {
    await PaymentEventModel.create({
      provider: 'razorpay',
      eventId,
      type: 'payment.captured',
      accountId: A,
      outcome,
      receivedAt,
      expiresAt: new Date(Date.now() + PAYMENT_EVENT_TTL_MS),
    });
  }
  // wallets: A ok, B low, C exhausted (+ the platform account has none)
  await WalletModel.updateOne(
    { accountId: A },
    { $set: { balanceMicros: 900 * RUPEE } },
    { upsert: true },
  );
  await WalletModel.updateOne(
    { accountId: B },
    { $set: { balanceMicros: 10 * RUPEE, lowBalanceThresholdMicros: 50 * RUPEE } },
    { upsert: true },
  );
  await WalletModel.updateOne({ accountId: C }, { $set: { balanceMicros: 0 } }, { upsert: true });
  await NotificationModel.create([
    {
      accountId: platform.account._id,
      userId: superadmin.user._id,
      type: 'billing.reconcile_mismatch',
      title: 't',
      body: 'b',
      expiresAt: new Date(Date.now() + 1e9),
    },
    {
      accountId: platform.account._id,
      userId: superadmin.user._id,
      type: 'billing.reconcile_mismatch',
      title: 't',
      body: 'b',
      readAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
  ]);
});

describe('platform billing summary', () => {
  it('adds up an IST month from a fixed fixture', async () => {
    const res = await get('/api/v1/admin/billing/summary?month=2025-03');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      month: '2025-03',
      from: '2025-02-28T18:30:00.000Z',
      to: '2025-03-31T18:30:00.000Z',
      ai: { playgroundTurns: 0, kbIngests: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0 },
      topups: {
        count: 2,
        baseMicros: 1500 * RUPEE,
        cgstMicros: 90 * RUPEE,
        sgstMicros: 90 * RUPEE,
        igstMicros: 90 * RUPEE,
        taxMicros: 270 * RUPEE,
        totalMicros: 1770 * RUPEE,
      },
      usage: {
        byType: [
          { type: 'ai_charge', amountMicros: 5 * RUPEE },
          { type: 'call_charge', amountMicros: 81 * RUPEE },
          { type: 'tts_charge', amountMicros: 2 * RUPEE },
        ],
        totalMicros: 88 * RUPEE,
      },
      adjustments: { creditMicros: 100 * RUPEE, debitMicros: 7 * RUPEE },
      topAccounts: [
        { accountId: b.account._id.toString(), name: 'Beta Credit', spendMicros: 52 * RUPEE },
        { accountId: a.account._id.toString(), name: 'Alpha Loans', spendMicros: 35 * RUPEE },
        { accountId: c.account._id.toString(), name: 'Gamma Finance', spendMicros: 1 * RUPEE },
      ],
      wallets: { total: 3, low: 1, exhausted: 1 },
      openReconcileMismatches: 1,
      paymentEventsNeedingAttention: 2,
    });
  });

  it('defaults to the current month and validates the month', async () => {
    const res = await get('/api/v1/admin/billing/summary');
    expect(res.status).toBe(200);
    expect(res.body.data.topups.count).toBe(0);
    expect(res.body.data.month).toMatch(/^\d{4}-\d{2}$/);
    for (const bad of ['2025-13', '2025-3', 'march']) {
      expect((await get(`/api/v1/admin/billing/summary?month=${bad}`)).status).toBe(422);
    }
    const dec = await get('/api/v1/admin/billing/summary?month=2024-12');
    expect(dec.body.data.to).toBe('2024-12-31T18:30:00.000Z');
  });
});

describe('payments and payment events', () => {
  it('lists top-up orders of every account with filters', async () => {
    const all = await get('/api/v1/admin/payments?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(5);
    const paid = await get('/api/v1/admin/payments?status=paid');
    expect(paid.body.data).toHaveLength(3);
    expect(paid.body.data[0]).toMatchObject({ accountName: 'Beta Credit', status: 'paid' });
    expect(paid.body.data[0].providerPaymentId).toMatch(/^pay_/);
    const byAccount = await get(`/api/v1/admin/payments?account=${c.account._id.toString()}`);
    expect(byAccount.body.data.map((o: { status: string }) => o.status).sort()).toEqual([
      'created',
      'failed',
    ]);
    // IST dates: 1 Mar – 31 Mar includes FIRST_IST, excludes LAST_UTC (1 Apr IST)
    const march = await get('/api/v1/admin/payments?from=2025-03-01&to=2025-03-31');
    expect(march.body.meta.total).toBe(4);
    expect((await get('/api/v1/admin/payments?from=2025-04-01&to=2025-03-01')).status).toBe(422);
    const deleted = new Types.ObjectId();
    await col('topupOrders').insertOne(order(deleted, 'paid', 1, IN, true));
    const ghost = await get(`/api/v1/admin/payments?account=${deleted.toString()}`);
    expect(ghost.body.data[0].accountName).toBeNull();
  });

  it('lists payment events newest first, filtered by outcome', async () => {
    const all = await get('/api/v1/admin/payment-events');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(5);
    expect(all.body.data.at(-1).eventId).toBe('evt_4');
    const unmatched = await get('/api/v1/admin/payment-events?outcome=unmatched');
    expect(unmatched.body.data).toEqual([
      expect.objectContaining({
        eventId: 'evt_2',
        outcome: 'unmatched',
        provider: 'razorpay',
        processedAt: null,
      }),
    ]);
    expect((await get('/api/v1/admin/payment-events?outcome=nope')).status).toBe(422);
  });
});
