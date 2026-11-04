import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { credit, transferCredit } from '../../src/core/billing/engine';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { UserModel } from '../../src/db/models/user.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { assertTopupAllowed } from '../../src/modules/wallet/topups.service';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });
const PASSWORD = 'green-falcon-lake-77';
const INR = 1_000_000;

const resellerInfo = (status: 'active' | 'pending_approval' = 'active') => ({
  status,
  customersCanTopUp: false,
  approvedAt: null,
  approvedBy: null,
  brand: null,
});

let reseller: TestAccount;
let rOwner: TestUser;
let rAgent: TestUser;
let other: TestUser;
let n = 0;

beforeAll(async () => {
  await requireRedis();
  reseller = await createTestAccount({ kind: 'reseller', reseller: resellerInfo() });
  rOwner = await reseller.addUser('owner');
  rAgent = await reseller.addUser('agent');
  const otherReseller = await createTestAccount({ kind: 'reseller', reseller: resellerInfo() });
  other = await otherReseller.addUser('owner');
  await credit({
    accountId: reseller.account._id,
    type: 'topup',
    amountMicros: 10_000 * INR,
    ref: { type: 'manual', id: 'seed' },
    idempotencyKey: `seed-${randomUUID()}`,
  });
});

const api = (u: TestUser) => ({
  get: (p: string) =>
    request(app).get(`/api/v1/reseller${p}`).set('Authorization', `Bearer ${u.token}`),
  post: (p: string, body: object = {}, key?: string) => {
    const r = request(app).post(`/api/v1/reseller${p}`).set('Authorization', `Bearer ${u.token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  },
  patch: (p: string, body: object) =>
    request(app).patch(`/api/v1/reseller${p}`).set('Authorization', `Bearer ${u.token}`).send(body),
});
const newCustomer = (u = rOwner, extra: object = {}) =>
  api(u).post(
    '/customers',
    {
      businessName: `Customer ${String(++n)}`,
      ownerName: 'Ravi',
      ownerEmail: `cust${String(n)}-${String(Date.now())}@example.com`,
      ownerPassword: PASSWORD,
      ...extra,
    },
    randomUUID(),
  );

describe('reseller panel (T19.5)', () => {
  it('creates a customer (no e-mail) with starting credit; lists it with wallet + owner', async () => {
    const res = await newCustomer(rOwner, { startingCreditMicros: 500 * INR });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'active', owner: { name: 'Ravi' } });
    const id = res.body.data.id as string;
    const acc = await AccountModel.findById(id).lean();
    expect(acc).toMatchObject({ kind: 'business', parentAccountId: reseller.account._id });
    const owner = await UserModel.findById(acc?.ownerId).lean();
    expect(owner?.emailVerifiedAt).toBeInstanceOf(Date);
    const list = await api(rOwner).get('/customers');
    const row = list.body.data.find((c: { id: string }) => c.id === id);
    expect(row.wallet.balanceMicros).toBe(500 * INR);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(
      await AuditLogModel.countDocuments({
        action: 'reseller.customer_created',
        'meta.customerId': id,
      }),
    ).toBe(2);
  });

  it('another reseller, a business and agents get 404 / 403', async () => {
    const id = (await newCustomer()).body.data.id as string;
    expect((await api(other).get(`/customers/${id}`)).status).toBe(404);
    expect(
      (await api(other).post(`/customers/${id}/credit`, { amountMicros: INR }, randomUUID()))
        .status,
    ).toBe(404);
    const biz = await createTestAccount();
    const bizOwner = await biz.addUser('owner');
    expect((await api(bizOwner).get('/customers')).status).toBe(404);
    expect((await api(rAgent).get('/customers')).status).toBe(403);
    expect((await newCustomer(rAgent)).status).toBe(403);
  });

  it('rename, suspend (campaigns pause), enable, reset owner password; audited', async () => {
    const id = (await newCustomer()).body.data.id as string;
    expect(
      (await api(rOwner).patch(`/customers/${id}`, { name: 'Renamed Co' })).body.data.name,
    ).toBe('Renamed Co');
    expect(
      (await api(rOwner).patch(`/customers/${id}`, { status: 'suspended' })).body.data.status,
    ).toBe('suspended');
    expect(
      (await api(rOwner).patch(`/customers/${id}`, { status: 'active' })).body.data.status,
    ).toBe('active');
    expect(
      (await api(rOwner).post(`/customers/${id}/owner-password`, { password: 'password' })).status,
    ).toBe(422);
    expect(
      (
        await api(rOwner).post(`/customers/${id}/owner-password`, {
          password: 'blue-river-tiger-91',
        })
      ).status,
    ).toBe(204);
    const actions = await AuditLogModel.distinct('action', { accountId: id });
    expect(actions).toEqual(
      expect.arrayContaining([
        'reseller.customer_suspended',
        'reseller.customer_enabled',
        'reseller.customer_password_reset',
      ]),
    );
  });

  it('a pending reseller cannot add customers; settings + top-up guard', async () => {
    const pending = await createTestAccount({
      kind: 'reseller',
      reseller: resellerInfo('pending_approval'),
    });
    const p = await pending.addUser('owner');
    const res = await newCustomer(p);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RESELLER_NOT_APPROVED');
    const id = (await newCustomer()).body.data.id as string;
    await expect(assertTopupAllowed(new Types.ObjectId(id))).rejects.toMatchObject({
      code: 'TOPUP_NOT_ALLOWED',
    });
    expect((await api(rOwner).patch('/settings', { customersCanTopUp: true })).body.data).toEqual({
      customersCanTopUp: true,
    });
    await expect(assertTopupAllowed(new Types.ObjectId(id))).resolves.toBeUndefined();
    await api(rOwner).patch('/settings', { customersCanTopUp: false });
  });
});

describe('credit transfer (T19.6)', () => {
  it('give and take back: both wallets, ledger pair sums to 0, bell, idempotent retry', async () => {
    const id = (await newCustomer()).body.data.id as string;
    const before =
      (await WalletModel.findOne({ accountId: reseller.account._id }).lean())?.balanceMicros ?? 0;
    const key = randomUUID();
    const give = await api(rOwner).post(
      `/customers/${id}/credit`,
      { amountMicros: 500 * INR, note: 'November' },
      key,
    );
    expect(give.status).toBe(200);
    expect(give.body.data).toMatchObject({ customerBalanceMicros: 500 * INR, replay: false });
    const again = await api(rOwner).post(
      `/customers/${id}/credit`,
      { amountMicros: 500 * INR, note: 'November' },
      key,
    );
    expect(again.body.data.transferId).toBe(give.body.data.transferId);
    expect((await WalletModel.findOne({ accountId: id }).lean())?.balanceMicros).toBe(500 * INR);
    const back = await api(rOwner).post(
      `/customers/${id}/credit/reclaim`,
      { amountMicros: 100 * INR },
      randomUUID(),
    );
    expect(back.body.data.customerBalanceMicros).toBe(400 * INR);
    expect(
      (await WalletModel.findOne({ accountId: reseller.account._id }).lean())?.balanceMicros,
    ).toBe(before - 400 * INR);
    const rows = await LedgerEntryModel.find({
      'ref.type': 'credit_transfer',
      'ref.id': give.body.data.transferId,
    }).lean();
    expect(rows.map((r) => r.type).sort()).toEqual(['credit_transfer_in', 'credit_transfer_out']);
    expect(
      await NotificationModel.countDocuments({ type: 'wallet.credit_received', accountId: id }),
    ).toBe(1);
    const tooMuch = await api(rOwner).post(
      `/customers/${id}/credit/reclaim`,
      { amountMicros: 1_000 * INR },
      randomUUID(),
    );
    expect(tooMuch.body.error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
    const st = await api(rOwner).get('/statement');
    expect(
      st.body.data.filter((r: { customer: { id: string } | null }) => r.customer?.id === id),
    ).toHaveLength(2);
    const csv = await api(rOwner).get('/statement?format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/^Date,Customer,Direction/);
    const detail = await api(rOwner).get(`/customers/${id}`);
    expect(
      detail.body.data.transfers.map((t: { direction: string }) => t.direction).sort(),
    ).toEqual(['given', 'taken_back']);
  });

  it('refuses more than the reseller has, a suspended customer, and never overdraws in parallel', async () => {
    const poor = await createTestAccount({ kind: 'reseller', reseller: resellerInfo() });
    const po = await poor.addUser('owner');
    await credit({
      accountId: poor.account._id,
      type: 'topup',
      amountMicros: 100 * INR,
      ref: { type: 'manual', id: 'seed' },
      idempotencyKey: `seed-${randomUUID()}`,
    });
    const id = (await newCustomer(po)).body.data.id as string;
    const short = await api(po).post(
      `/customers/${id}/credit`,
      { amountMicros: 101 * INR },
      randomUUID(),
    );
    expect(short.body.error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        transferCredit({
          fromAccountId: poor.account._id,
          toAccountId: id,
          amountMicros: 30 * INR,
          transferId: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await WalletModel.findOne({ accountId: poor.account._id }).lean())?.balanceMicros).toBe(
      10 * INR,
    );
    await api(po).patch(`/customers/${id}`, { status: 'suspended' });
    const sus = await api(po).post(`/customers/${id}/credit`, { amountMicros: INR }, randomUUID());
    expect(sus.body.error.code).toBe('CONFLICT_INVALID_STATE');
  });
});

describe('reseller dashboard (T19.7)', () => {
  it('counts customers, credit given this month and low-balance customers', async () => {
    const fresh = await createTestAccount({ kind: 'reseller', reseller: resellerInfo() });
    const fo = await fresh.addUser('owner');
    await credit({
      accountId: fresh.account._id,
      type: 'topup',
      amountMicros: 1_000 * INR,
      ref: { type: 'manual', id: 'seed' },
      idempotencyKey: `seed-${randomUUID()}`,
    });
    await newCustomer(fo, { startingCreditMicros: 200 * INR });
    const second = (await newCustomer(fo)).body.data.id as string;
    await api(fo).patch(`/customers/${second}`, { status: 'suspended' });
    const s = await api(fo).get('/summary');
    expect(s.body.data).toMatchObject({
      customers: { active: 1, suspended: 1, total: 2 },
      creditGivenThisMonthMicros: 200 * INR,
    });
    expect(s.body.data.lowBalanceCustomers.map((c: { id: string }) => c.id)).toContain(second);
  });
});

describe('wallet provider (T19.8)', () => {
  it("a reseller's customer sees its provider and whether it may top up", async () => {
    const id = (await newCustomer()).body.data.id as string;
    const acc = await AccountModel.findById(id).lean();
    const owner = await UserModel.findById(acc?.ownerId).lean();
    if (!owner) throw new Error('no owner');
    const token = await tokenFor(owner);
    const res = await request(app)
      .get('/api/v1/wallet/provider')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toEqual({
      provider: { name: reseller.account.name },
      topupAllowed: false,
    });
    const direct = await request(app)
      .get('/api/v1/wallet/provider')
      .set('Authorization', `Bearer ${other.token}`);
    expect(direct.body.data).toEqual({ provider: null, topupAllowed: true });
  });
});
