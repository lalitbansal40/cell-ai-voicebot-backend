import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { expireTopupOrders } from '../../src/core/billing/orders';
import { createFakePaymentProvider } from '../../src/core/payments';
import { AccountModel } from '../../src/db/models/account.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { PaymentEventModel } from '../../src/db/models/payment-event.model';
import { TopupOrderModel } from '../../src/db/models/topup-order.model';
import { UserModel } from '../../src/db/models/user.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import * as loggerModule from '../../src/shared/logger';
import { recordingBillingJobs } from '../helpers/billing';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const RUPEE = 1_000_000;
const fake = createFakePaymentProvider('webhook-test-secret');
const rec = recordingBillingJobs();
const app = buildTestApp({}, { payments: fake, billingJobs: rec.jobs });
let superadminId: Types.ObjectId;

beforeAll(async () => {
  const platform = await AccountModel.create({
    name: 'Platform',
    slug: 'platform-w',
    isPlatform: true,
  });
  superadminId = (
    await UserModel.create({
      accountId: platform._id,
      roleId: new Types.ObjectId(),
      name: 'Root',
      email: 'root-w@platform.local',
      status: 'active',
      platformRole: 'superadmin',
    })
  )._id;
});

const order = async (extra: Record<string, unknown> = {}) =>
  TopupOrderModel.create({
    accountId: new Types.ObjectId(),
    provider: 'fake',
    providerOrderId: `order_fake_${new Types.ObjectId().toString()}`,
    status: 'created',
    baseMicros: 1000 * RUPEE,
    cgstMicros: 90 * RUPEE,
    sgstMicros: 90 * RUPEE,
    taxMicros: 180 * RUPEE,
    totalMicros: 1180 * RUPEE,
    buyer: {
      legalName: 'Test Co',
      email: 'b@example.com',
      addressLine1: '1 Road',
      city: 'Jaipur',
      stateCode: '08',
      pin: '302001',
    },
    createdBy: new Types.ObjectId(),
    ...extra,
  });

const capturedEvent = (
  providerOrderId: string,
  extra: Record<string, unknown> = {},
  event = 'payment.captured',
) => ({
  event,
  payload: {
    payment: {
      entity: {
        id: `pay_${new Types.ObjectId().toString()}`,
        order_id: providerOrderId,
        status: event === 'payment.failed' ? 'failed' : 'captured',
        amount: 118_000,
        currency: 'INR',
        ...extra,
      },
    },
  },
});

let ev = 0;
const send = (
  body: unknown,
  {
    eventId = `evt_${(ev += 1)}`,
    sign = true,
    signature,
  }: { eventId?: string | null; sign?: boolean; signature?: string } = {},
) => {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('content-type', 'application/json');
  if (eventId) req.set('x-razorpay-event-id', eventId);
  if (sign) req.set('x-razorpay-signature', signature ?? fake.signWebhook(raw));
  // send a string: supertest re-serialises Buffers, strings go out byte-for-byte
  return req.send(raw.toString('utf8'));
};

describe('POST /webhooks/razorpay', () => {
  it('credits a captured payment once; replays are deduped by event id', async () => {
    const o = await order();
    const body = capturedEvent(o.providerOrderId ?? '');
    const first = await send(body, { eventId: 'evt_dup' });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ duplicate: false, outcome: 'credited' });
    expect((await TopupOrderModel.findById(o._id).lean())?.status).toBe('paid');
    expect((await WalletModel.findOne({ accountId: o.accountId }).lean())?.balanceMicros).toBe(
      1000 * RUPEE,
    );
    expect((await send(body, { eventId: 'evt_dup' })).body.data).toEqual({
      duplicate: true,
      outcome: 'received',
    });
    // the same payment under a new event id (e.g. order.paid) is a duplicate credit
    expect((await send({ ...body, event: 'order.paid' })).body.data.outcome).toBe(
      'duplicate_credit',
    );
    expect(await LedgerEntryModel.countDocuments({ accountId: o.accountId })).toBe(1);
    const row = await PaymentEventModel.findOne({ eventId: 'evt_dup' }).lean();
    expect(row).toMatchObject({
      type: 'payment.captured',
      outcome: 'credited',
      providerOrderId: o.providerOrderId,
    });
    expect(row?.accountId?.toString()).toBe(o.accountId.toString());
  });

  it('accepts order.paid with the order id in the order entity', async () => {
    const o = await order();
    const body = {
      event: 'order.paid',
      payload: {
        order: { entity: { id: o.providerOrderId } },
        payment: {
          entity: { id: 'pay_op_1', status: 'captured', amount: 118_000, currency: 'INR' },
        },
      },
    };
    expect((await send(body)).body.data.outcome).toBe('credited');
  });

  it('rejects missing, wrong or tampered signatures without storing anything', async () => {
    const o = await order();
    const body = capturedEvent(o.providerOrderId ?? '');
    const before = await PaymentEventModel.countDocuments({});
    expect((await send(body, { sign: false })).status).toBe(401);
    expect((await send(body, { signature: 'f'.repeat(64) })).status).toBe(401);
    const raw = Buffer.from(JSON.stringify(body));
    const tampered = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', fake.signWebhook(raw))
      .send(JSON.stringify({ ...body, event: 'refund.processed' }));
    expect(tampered.status).toBe(401);
    expect(await PaymentEventModel.countDocuments({})).toBe(before);
    expect((await TopupOrderModel.findById(o._id).lean())?.status).toBe('created');
  });

  it('reports unknown orders and mismatched payments to superadmins', async () => {
    const unknown = await send(capturedEvent('order_nobody'));
    expect(unknown.body.data.outcome).toBe('unmatched');
    const o = await order();
    const mismatch = await send(capturedEvent(o.providerOrderId ?? '', { amount: 100 }));
    expect(mismatch.body.data.outcome).toBe('mismatch');
    expect((await TopupOrderModel.findById(o._id).lean())?.status).toBe('created');
    const types = (await NotificationModel.find({ userId: superadminId }).lean()).map(
      (n) => n.type,
    );
    expect(types).toEqual(
      expect.arrayContaining(['billing.payment_unmatched', 'billing.payment_mismatch']),
    );
  });

  it('marks failed attempts, and still credits a later success on the same order', async () => {
    const o = await order();
    const failed = await send(
      capturedEvent(
        o.providerOrderId ?? '',
        { error_description: 'Card declined by bank' },
        'payment.failed',
      ),
    );
    expect(failed.body.data.outcome).toBe('failed');
    expect(await TopupOrderModel.findById(o._id).lean()).toMatchObject({
      status: 'failed',
      failureReason: 'Card declined by bank',
    });
    expect((await send(capturedEvent(o.providerOrderId ?? ''))).body.data.outcome).toBe('credited');
    expect((await TopupOrderModel.findById(o._id).lean())?.status).toBe('paid');
    expect(
      (await send(capturedEvent('order_nobody', {}, 'payment.failed'))).body.data.outcome,
    ).toBe('unmatched');
  });

  it('credits a late payment on an expired order (logged)', async () => {
    const o = await order({ status: 'expired' });
    expect((await send(capturedEvent(o.providerOrderId ?? ''))).body.data.outcome).toBe('credited');
  });

  it('reports refunds, ignores unknown events, dedupes by body hash without an event id', async () => {
    expect((await send({ event: 'refund.processed', payload: {} })).body.data.outcome).toBe(
      'refund',
    );
    expect(
      await NotificationModel.countDocuments({
        userId: superadminId,
        type: 'billing.refund_received',
      }),
    ).toBe(1);
    expect((await send({ event: 'subscription.charged' })).body.data.outcome).toBe('ignored');
    expect((await send({ nothing: true })).body.data.outcome).toBe('ignored');
    const body = { event: 'payment.authorized', payload: {} };
    expect((await send(body, { eventId: null })).body.data.duplicate).toBe(false);
    expect((await send(body, { eventId: null })).body.data.duplicate).toBe(true);
  });

  it('needs a JSON body; malformed JSON with a valid signature is a 422', async () => {
    expect((await send('not json')).status).toBe(422);
    const text = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'text/plain')
      .set('x-razorpay-signature', 'x')
      .send('hello');
    expect(text.status).toBe(422);
  });

  it('limits the body to 256 KB', async () => {
    const big = JSON.stringify({ event: 'x', pad: 'a'.repeat(300 * 1024) });
    expect((await send(big)).status).toBe(413);
  });

  it('never logs the body or the signature', async () => {
    const calls: unknown[] = [];
    const sink = {
      info: (...a: unknown[]) => calls.push(a),
      warn: (...a: unknown[]) => calls.push(a),
      error: (...a: unknown[]) => calls.push(a),
      debug: () => undefined,
    };
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue(sink as never);
    const o = await order();
    const body = capturedEvent(o.providerOrderId ?? '');
    const raw = Buffer.from(JSON.stringify(body));
    const signature = fake.signWebhook(raw);
    await send(body, { signature });
    vi.restoreAllMocks();
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain('"amount"');
    expect(logged).toContain('payments: webhook processed');
  });

  it('keeps the JSON parser for every other route', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REQUEST_MALFORMED');
  });
});

describe('order expiry', () => {
  it('expires old unpaid orders and fails orders stuck in "creating"', async () => {
    const old = new Date(Date.now() - 25 * 3_600_000);
    const a = await order();
    const b = await order({ status: 'creating', providerOrderId: null });
    const fresh = await order();
    await TopupOrderModel.collection.updateMany(
      { _id: { $in: [a._id, b._id] } },
      { $set: { createdAt: old } },
    );
    expect(await expireTopupOrders()).toEqual({ expired: 1, stuck: 1 });
    expect((await TopupOrderModel.findById(a._id).lean())?.status).toBe('expired');
    expect(await TopupOrderModel.findById(b._id).lean()).toMatchObject({
      status: 'failed',
      failureReason: 'stuck_creating',
    });
    expect((await TopupOrderModel.findById(fresh._id).lean())?.status).toBe('created');
  });
});
