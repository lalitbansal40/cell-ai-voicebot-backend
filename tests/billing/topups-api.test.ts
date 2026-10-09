import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createFakePaymentProvider,
  hmacHex,
  type PaymentProvider,
  type ProviderPayment,
} from '../../src/core/payments';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { InvoiceModel } from '../../src/db/models/invoice.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { TopupOrderModel } from '../../src/db/models/topup-order.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { AppError } from '../../src/shared/errors/app-error';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingBillingJobs } from '../helpers/billing';
import { useTestDb } from '../helpers/db';
import { PRODUCTION_BILLING_ENV } from '../helpers/production-env';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const RUPEE = 1_000_000;
const rec = recordingBillingJobs();
const app = buildTestApp({}, { billingJobs: rec.jobs });
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

const PROFILE = {
  legalName: 'Test Finance Pvt Ltd',
  email: 'billing@example.com',
  addressLine1: '1 MI Road',
  addressLine2: null,
  city: 'Jaipur',
  stateCode: '08',
  pin: '302001',
  gstin: null,
  updatedAt: new Date(),
};

let n = 0;
const owner = async (
  profile: Record<string, unknown> | null = PROFILE,
): Promise<TestUser & { t: TestAccount }> => {
  n += 1;
  const t = await createTestAccount({
    name: `Topup Co ${n}`,
    ...(profile ? { billing: profile as never } : {}),
  });
  return { ...(await t.addUser('owner')), t };
};
let key = 0;
const create = (
  u: { token: string },
  amountMicros: number,
  idem = `k-${(key += 1)}`,
  server = app,
) =>
  request(server)
    .post('/api/v1/wallet/topups')
    .set(auth(u))
    .set('Idempotency-Key', idem)
    .send({ amountMicros });

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});

describe('POST /wallet/topups', () => {
  it('creates an order with GST and checkout details; Idempotency-Key replays it', async () => {
    const u = await owner();
    const res = await create(u, 1000 * RUPEE, 'same-key');
    expect(res.status).toBe(201);
    expect(res.body.data.topupOrder).toMatchObject({
      provider: 'fake',
      status: 'created',
      baseMicros: 1000 * RUPEE,
      cgstMicros: 90 * RUPEE,
      sgstMicros: 90 * RUPEE,
      igstMicros: 0,
      totalMicros: 1180 * RUPEE,
      currency: 'INR',
      paidAt: null,
    });
    expect(res.body.data.checkout).toMatchObject({
      provider: 'fake',
      keyId: null,
      amountPaise: 118_000,
      currency: 'INR',
      prefill: { name: 'Test Finance Pvt Ltd', email: 'billing@example.com' },
    });
    expect(res.body.data.checkout.providerOrderId).toMatch(/^order_fake_/);
    const replay = await create(u, 1000 * RUPEE, 'same-key');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.topupOrder.id).toBe(res.body.data.topupOrder.id);
    expect(await TopupOrderModel.countDocuments({ accountId: u.t.account._id })).toBe(1);
    expect((await create(u, 2000 * RUPEE, 'same-key')).body.error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('uses IGST for another state and snapshots the buyer', async () => {
    const u = await owner({ ...PROFILE, stateCode: '27' });
    const res = await create(u, 500 * RUPEE);
    expect(res.body.data.topupOrder).toMatchObject({
      cgstMicros: 0,
      igstMicros: 90 * RUPEE,
      totalMicros: 590 * RUPEE,
    });
    const order = await TopupOrderModel.findById(res.body.data.topupOrder.id).lean();
    expect(order?.buyer).toMatchObject({ legalName: 'Test Finance Pvt Ltd', stateCode: '27' });
  });

  it('validates the amount, the header and the billing profile', async () => {
    const u = await owner();
    for (const amount of [99 * RUPEE, 500_001 * RUPEE, 100 * RUPEE + 500_000, 0]) {
      expect((await create(u, amount)).status, String(amount)).toBe(422);
    }
    const noKey = await request(app)
      .post('/api/v1/wallet/topups')
      .set(auth(u))
      .send({ amountMicros: 100 * RUPEE });
    expect(noKey.status).toBe(422);
    const bare = await owner(null);
    const res = await create(bare, 100 * RUPEE);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BILLING_PROFILE_REQUIRED');
  });

  it('is for owners / admins only, never while impersonating or suspended', async () => {
    const u = await owner();
    const manager = await u.t.addUser('manager');
    const viewer = await u.t.addUser('viewer');
    expect((await create(manager, 100 * RUPEE)).status).toBe(403);
    expect((await create(viewer, 100 * RUPEE)).status).toBe(403);
    const imp = { token: await tokenFor(u.user, { imp: new Types.ObjectId().toString() }) };
    expect((await create(imp, 100 * RUPEE)).body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    await AccountModel.updateOne({ _id: u.t.account._id }, { $set: { status: 'suspended' } });
    expect((await create(u, 100 * RUPEE)).body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('limits orders to 10 per hour per account', async () => {
    const u = await owner();
    for (let i = 0; i < 10; i += 1) expect((await create(u, 100 * RUPEE)).status).toBe(201);
    expect((await create(u, 100 * RUPEE)).status).toBe(429);
    const other = await owner();
    expect((await create(other, 100 * RUPEE)).status).toBe(201);
  });

  it('marks the order failed when the gateway is down', async () => {
    const payments = createFakePaymentProvider('x');
    vi.spyOn(payments, 'createOrder').mockRejectedValueOnce(new AppError('PROVIDER_UNAVAILABLE'));
    const server = buildTestApp({}, { payments, billingJobs: rec.jobs });
    const u = await owner();
    const res = await create(u, 100 * RUPEE, 'down-1', server);
    expect(res.status).toBe(503);
    expect(await TopupOrderModel.findOne({ accountId: u.t.account._id }).lean()).toMatchObject({
      status: 'failed',
      failureReason: 'provider_error',
    });
  });
});

describe('paying a top-up', () => {
  it('fake-complete pays: wallet credit, ledger, invoice, render job, audit, bell', async () => {
    rec.queued.length = 0;
    const u = await owner();
    const id = (await create(u, 1000 * RUPEE)).body.data.topupOrder.id as string;
    const paid = await request(app)
      .post(`/api/v1/wallet/topups/${id}/fake-complete`)
      .set(auth(u))
      .send({ outcome: 'paid' });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'paid' });
    expect(paid.body.data.invoiceId).toMatch(/^[a-f0-9]{24}$/);
    const wallet = await WalletModel.findOne({ accountId: u.t.account._id }).lean();
    expect(wallet?.balanceMicros).toBe(1000 * RUPEE);
    const row = await LedgerEntryModel.findOne({ accountId: u.t.account._id }).lean();
    expect(row).toMatchObject({
      type: 'topup',
      direction: 'credit',
      status: 'captured',
      amountMicros: 1000 * RUPEE,
      ref: { type: 'topup', id },
    });
    const invoice = await InvoiceModel.findById(paid.body.data.invoiceId).lean();
    expect(invoice).toMatchObject({
      status: 'rendering',
      sacCode: '998319',
      placeOfSupply: { stateCode: '08', stateName: 'Rajasthan' },
      amounts: {
        baseMicros: 1000 * RUPEE,
        cgstMicros: 90 * RUPEE,
        sgstMicros: 90 * RUPEE,
        totalMicros: 1180 * RUPEE,
      },
      seller: { stateCode: '08' },
    });
    expect(invoice?.number).toMatch(/^CAV\/\d{2}-\d{2}\/\d{6}$/);
    expect(rec.queued).toEqual([
      {
        name: 'invoice.render',
        data: { accountId: u.t.account._id.toString(), invoiceId: paid.body.data.invoiceId },
      },
    ]);
    const audit = await AuditLogModel.findOne({
      accountId: u.t.account._id,
      action: 'wallet.topup_paid',
    }).lean();
    expect(audit?.meta).toMatchObject({
      amountMicros: 1000 * RUPEE,
      invoiceNumber: invoice?.number,
    });
    expect(
      await NotificationModel.countDocuments({
        accountId: u.t.account._id,
        type: 'wallet.topup_paid',
      }),
    ).toBe(1);
    const again = await request(app)
      .post(`/api/v1/wallet/topups/${id}/fake-complete`)
      .set(auth(u))
      .send({ outcome: 'paid' });
    expect(again.status).toBe(409);
    expect(
      (await request(app).get(`/api/v1/wallet/topups/${id}`).set(auth(u))).body.data.status,
    ).toBe('paid');
  });

  it('numbers invoices consecutively', async () => {
    const u = await owner();
    const numbers: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const id = (await create(u, 100 * RUPEE)).body.data.topupOrder.id as string;
      const paid = await request(app)
        .post(`/api/v1/wallet/topups/${id}/fake-complete`)
        .set(auth(u))
        .send({ outcome: 'paid' });
      numbers.push((await InvoiceModel.findById(paid.body.data.invoiceId).lean())?.number ?? '');
    }
    const seq = numbers.map((x) => Number(x.split('/')[2]));
    expect(seq[1]).toBe((seq[0] ?? 0) + 1);
  });

  it('fake-complete fails an order without moving money', async () => {
    const u = await owner();
    const id = (await create(u, 100 * RUPEE)).body.data.topupOrder.id as string;
    const failed = await request(app)
      .post(`/api/v1/wallet/topups/${id}/fake-complete`)
      .set(auth(u))
      .send({ outcome: 'failed' });
    expect(failed.body.data).toMatchObject({
      status: 'failed',
      failureReason: 'Test payment declined',
    });
    expect(await LedgerEntryModel.countDocuments({ accountId: u.t.account._id })).toBe(0);
  });

  it('lists recharges, newest first; other accounts see nothing', async () => {
    const u = await owner();
    await create(u, 100 * RUPEE);
    await create(u, 200 * RUPEE);
    const viewer = await u.t.addUser('viewer');
    const list = await request(app).get('/api/v1/wallet/topups?limit=1').set(auth(viewer));
    expect(list.body.data[0].baseMicros).toBe(200 * RUPEE);
    expect(list.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    const other = await owner();
    expect(
      (
        await request(app)
          .get(`/api/v1/wallet/topups/${list.body.data[0].id as string}`)
          .set(auth(other))
      ).status,
    ).toBe(404);
  });
});

describe('POST /wallet/topups/:id/verify', () => {
  const stub = (payment: Partial<ProviderPayment>) => {
    const capture = vi.fn((id: string) =>
      Promise.resolve<ProviderPayment>({
        id,
        orderId: payment.orderId ?? null,
        status: 'captured',
        amountPaise: payment.amountPaise ?? 0,
        currency: 'INR',
        errorDescription: null,
      }),
    );
    const payments: PaymentProvider & { capture: typeof capture } = {
      capture,
      name: 'razorpay',
      keyId: 'rzp_test_k',
      createOrder: () =>
        Promise.resolve({ id: `order_${new Types.ObjectId().toString()}`, status: 'created' }),
      fetchPayment: vi.fn((id: string) =>
        Promise.resolve<ProviderPayment>({
          id,
          orderId: null,
          status: 'captured',
          amountPaise: 0,
          currency: 'INR',
          errorDescription: null,
          ...payment,
        }),
      ),
      capturePayment: capture,
      verifyCheckoutSignature: (o, p, s) => s === hmacHex('k', `${o}|${p}`),
      verifyWebhookSignature: () => false,
    };
    return payments;
  };
  const setup = async (payment: Partial<ProviderPayment> = {}) => {
    const u = await owner();
    const payId = `pay_${new Types.ObjectId().toString()}`;
    let payments = stub(payment);
    const server = buildTestApp(
      { PAYMENT_PROVIDER: 'razorpay', ...PRODUCTION_BILLING_ENV },
      { payments, billingJobs: rec.jobs },
    );
    const created = await create(u, 1000 * RUPEE, `v-${(key += 1)}`, server);
    const order = created.body.data.topupOrder as { id: string; providerOrderId: string };
    payments = stub({ orderId: order.providerOrderId, amountPaise: 118_000, ...payment });
    const app2 = buildTestApp(
      { PAYMENT_PROVIDER: 'razorpay', ...PRODUCTION_BILLING_ENV },
      { payments, billingJobs: rec.jobs },
    );
    const verify = (
      paymentId = payId,
      signature = hmacHex('k', `${order.providerOrderId}|${paymentId}`),
      who: { token: string } = u,
    ) =>
      request(app2)
        .post(`/api/v1/wallet/topups/${order.id}/verify`)
        .set(auth(who))
        .send({ providerPaymentId: paymentId, signature });
    return { u, order, payments, verify, app2, payId };
  };

  it('credits a captured payment once, even when verified twice in parallel', async () => {
    const { u, verify } = await setup();
    const [a, b] = await Promise.all([verify(), verify()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.status).toBe('paid');
    expect((await WalletModel.findOne({ accountId: u.t.account._id }).lean())?.balanceMicros).toBe(
      1000 * RUPEE,
    );
    expect(await LedgerEntryModel.countDocuments({ accountId: u.t.account._id })).toBe(1);
    expect((await verify()).body.data.status).toBe('paid'); // later verify: same result
  });

  it('captures an authorized payment first', async () => {
    const { verify, payments, payId } = await setup({ status: 'authorized' });
    const r = await verify();
    expect(r.body.data.status).toBe('paid');
    expect(payments.capture).toHaveBeenCalledWith(payId, 118_000);
  });

  it.each([
    ['a bad signature', {}, 'wrong'],
    ['a payment that is not captured', { status: 'failed' as const }, undefined],
    ['a different amount', { amountPaise: 100 }, undefined],
    ['another currency', { currency: 'USD' }, undefined],
    ['another order', { orderId: 'order_other' }, undefined],
  ])('refuses %s', async (_name, payment, signature) => {
    const { u, verify } = await setup(payment);
    const res = await verify(undefined, signature);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect((await TopupOrderModel.findOne({ accountId: u.t.account._id }).lean())?.status).toBe(
      'created',
    );
    expect(await LedgerEntryModel.countDocuments({ accountId: u.t.account._id })).toBe(0);
  });

  it('refuses other accounts, failed / stuck orders, and has no fake route with razorpay', async () => {
    const { order, verify, app2 } = await setup();
    const other = await owner();
    expect((await verify(undefined, undefined, other)).status).toBe(404);
    await TopupOrderModel.updateOne({ _id: order.id }, { $set: { status: 'creating' } });
    expect((await verify()).status).toBe(409);
    await TopupOrderModel.updateOne({ _id: order.id }, { $set: { status: 'failed' } });
    expect((await verify()).status).toBe(409);
    const u2 = await owner();
    expect(
      (
        await request(app2)
          .post(`/api/v1/wallet/topups/${order.id}/fake-complete`)
          .set(auth(u2))
          .send({ outcome: 'paid' })
      ).status,
    ).toBe(404);
  });

  it('credits a late payment on an expired order', async () => {
    const { u, order, verify } = await setup();
    await TopupOrderModel.updateOne({ _id: order.id }, { $set: { status: 'expired' } });
    expect((await verify()).body.data.status).toBe('paid');
    expect((await WalletModel.findOne({ accountId: u.t.account._id }).lean())?.balanceMicros).toBe(
      1000 * RUPEE,
    );
  });
});
