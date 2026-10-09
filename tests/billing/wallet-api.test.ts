import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { BILLING_LIMITS } from '../../src/config/limits';
import {
  adjust,
  chargeUsage,
  credit,
  holdForCall,
  settleCall,
} from '../../src/core/billing/engine';
import { createRateCardVersion, invalidateRateCardCache } from '../../src/core/billing/rates';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { makeGstin } from '../../src/shared/gstin';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const RUPEE = 1_000_000;
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

let t: TestAccount;
let other: TestAccount;
let owner: TestUser;
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let viewer: TestUser;
let otherOwner: TestUser;
const acc = () => t.account._id;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  t = await createTestAccount({ timezone: 'Asia/Kolkata' });
  other = await createTestAccount();
  owner = await t.addUser('owner');
  admin = await t.addUser('admin');
  manager = await t.addUser('manager');
  agent = await t.addUser('agent');
  viewer = await t.addUser('viewer');
  otherOwner = await other.addUser('owner');
  await credit({
    accountId: acc(),
    type: 'topup',
    amountMicros: 1000 * RUPEE,
    ref: { type: 'topup', id: 'seed' },
    idempotencyKey: 'seed-topup',
    createdBy: owner.user._id,
  });
});
afterEach(() => invalidateRateCardCache());

const get = (path: string, u: { token: string } = owner) => request(app).get(path).set(auth(u));

describe('GET /wallet', () => {
  it('returns the wallet view without internals', async () => {
    const res = await get('/api/v1/wallet');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currency: 'INR',
      balanceMicros: 1000 * RUPEE,
      holdMicros: 0,
      availableMicros: 1000 * RUPEE,
      creditLimitMicros: 0,
      status: 'ok',
      lowBalanceThresholdMicros: 500 * RUPEE,
      budgets: { monthlyCallMicros: 0, monthlyAiMicros: 0 },
    });
    expect(res.body.data.monthSpend.month).toMatch(/^\d{4}-\d{2}$/);
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        'availableMicros',
        'balanceMicros',
        'budgets',
        'creditLimitMicros',
        'currency',
        'holdMicros',
        'lowBalanceThresholdMicros',
        'monthSpend',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('is readable by owner / admin / manager / viewer, not by agents', async () => {
    for (const u of [admin, manager, viewer])
      expect((await get('/api/v1/wallet', u)).status).toBe(200);
    expect((await get('/api/v1/wallet', agent)).status).toBe(403);
    expect((await request(app).get('/api/v1/wallet')).status).toBe(401);
  });

  it('shows last month’s spend as 0 and a low status under the threshold', async () => {
    const x = await createTestAccount();
    const xo = await x.addUser('owner');
    await credit({
      accountId: x.account._id,
      type: 'topup',
      amountMicros: 100 * RUPEE,
      ref: { type: 'manual', id: 'x' },
      idempotencyKey: 'x',
    });
    await WalletModel.updateOne(
      { accountId: x.account._id },
      { $set: { spend: { month: '2000-01', callMicros: 5, aiMicros: 5, ttsMicros: 5 } } },
    );
    const res = await get('/api/v1/wallet', xo);
    expect(res.body.data.status).toBe('low');
    expect(res.body.data.monthSpend).toMatchObject({ callMicros: 0, totalMicros: 0 });
  });
});

describe('PATCH /wallet/settings', () => {
  it('updates threshold and budgets with an audit entry', async () => {
    const res = await request(app)
      .patch('/api/v1/wallet/settings')
      .set(auth(owner))
      .send({ lowBalanceThresholdMicros: 200 * RUPEE, budgets: { monthlyAiMicros: 50 * RUPEE } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      lowBalanceThresholdMicros: 200 * RUPEE,
      budgets: { monthlyCallMicros: 0, monthlyAiMicros: 50 * RUPEE },
    });
    const audit = await AuditLogModel.findOne({
      accountId: acc(),
      action: 'wallet.settings_updated',
    }).lean();
    expect(audit?.meta).toMatchObject({
      fields: ['lowBalanceThresholdMicros', 'monthlyAiMicros'],
      from: { lowBalanceThresholdMicros: 500 * RUPEE, monthlyAiMicros: 0 },
      to: { lowBalanceThresholdMicros: 200 * RUPEE, monthlyAiMicros: 50 * RUPEE },
    });
    // same values again → no new audit row
    await request(app)
      .patch('/api/v1/wallet/settings')
      .set(auth(admin))
      .send({ lowBalanceThresholdMicros: 200 * RUPEE });
    expect(
      await AuditLogModel.countDocuments({ accountId: acc(), action: 'wallet.settings_updated' }),
    ).toBe(1);
    await request(app)
      .patch('/api/v1/wallet/settings')
      .set(auth(owner))
      .send({ budgets: { monthlyCallMicros: 0 } });
  });

  it('validates and guards the route', async () => {
    const patch = (body: unknown, u: { token: string } = owner) =>
      request(app)
        .patch('/api/v1/wallet/settings')
        .set(auth(u))
        .send(body as object);
    for (const body of [
      {},
      { lowBalanceThresholdMicros: -1 },
      { lowBalanceThresholdMicros: 1.5 },
      { lowBalanceThresholdMicros: BILLING_LIMITS.thresholdMaxMicros + 1 },
      { budgets: {} },
      { budgets: { monthlyCallMicros: BILLING_LIMITS.budgetMaxMicros + 1 } },
      { extra: true },
    ]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await patch({ lowBalanceThresholdMicros: 0 }, manager)).status).toBe(403);
    expect((await patch({ lowBalanceThresholdMicros: 0 }, viewer)).status).toBe(403);
    const imp = { token: await tokenFor(owner.user, { imp: new Types.ObjectId().toString() }) };
    const blocked = await patch({ lowBalanceThresholdMicros: 0 }, imp);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await get('/api/v1/wallet', imp)).status).toBe(200); // reads allowed
  });

  it('is read-only for a suspended account', async () => {
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect(
      (
        await request(app)
          .patch('/api/v1/wallet/settings')
          .set(auth(so))
          .send({ lowBalanceThresholdMicros: 0 })
      ).status,
    ).toBe(403);
    expect((await get('/api/v1/wallet', so)).status).toBe(200);
  });
});

describe('GET /wallet/rates and POST /wallet/estimate', () => {
  it('shows the effective prices (default, then the account override)', async () => {
    expect((await get('/api/v1/wallet/rates')).body.data).toMatchObject({
      ...DEFAULT_RATE_CARD,
      source: 'default',
    });
    await createRateCardVersion({
      accountId: acc(),
      values: { ...DEFAULT_RATE_CARD, callPerMinuteMicros: 800_000, pulseSeconds: 30 },
      createdBy: null,
    });
    const res = await get('/api/v1/wallet/rates', viewer);
    expect(res.body.data).toMatchObject({
      callPerMinuteMicros: 800_000,
      pulseSeconds: 30,
      source: 'account',
    });
    expect(res.body.data).not.toHaveProperty('id');
    await RateCardModel.deleteMany({ accountId: acc() });
  });

  it('estimates a campaign', async () => {
    const res = await request(app)
      .post('/api/v1/wallet/estimate')
      .set(auth(manager))
      .send({ calls: 100, avgDurationSec: 90, answerRateBps: 5000, aiShareBps: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      answeredCalls: 50,
      perCallMicros: 6_500_000,
      totalMicros: 325_000_000,
      holdPerCallMicros: 21 * RUPEE,
    });
    expect(
      (
        await request(app)
          .post('/api/v1/wallet/estimate')
          .set(auth(owner))
          .send({ calls: 0, avgDurationSec: 1 })
      ).status,
    ).toBe(422);
    const defaults = await request(app)
      .post('/api/v1/wallet/estimate')
      .set(auth(owner))
      .send({ calls: 10, avgDurationSec: 60 });
    expect(defaults.body.data.answeredCalls).toBe(5);
  });
});

describe('ledger', () => {
  let chargeId = '';
  beforeAll(async () => {
    const hold = await holdForCall({
      accountId: acc(),
      ref: { type: 'simulator', id: 'c1' },
      idempotencyKey: 'hold:c1',
    });
    const settled = await settleCall({
      accountId: acc(),
      holdId: hold.entries[0]?._id ?? '',
      usage: { answered: true, durationSec: 90, aiSeconds: 30 },
    });
    chargeId = settled.entries[0]?._id.toString() ?? '';
    await holdForCall({
      accountId: acc(),
      ref: { type: 'simulator', id: 'c2' },
      idempotencyKey: 'hold:c2',
    });
    await chargeUsage({
      accountId: acc(),
      type: 'tts_charge',
      amountMicros: RUPEE,
      ref: { type: 'usage', id: 'u1' },
      idempotencyKey: 'u1',
    });
    await adjust({
      accountId: acc(),
      direction: 'credit',
      amountMicros: 5 * RUPEE,
      reason: '=HYPERLINK("x")',
      createdBy: admin.user._id,
      idempotencyKey: 'adj-formula',
    });
  });

  it('lists newest first with descriptions, filters and names', async () => {
    const res = await get('/api/v1/wallet/ledger');
    expect(res.status).toBe(200);
    const rows = res.body.data as {
      description: string;
      type: string;
      status: string;
      createdBy: unknown;
    }[];
    expect(rows.map((r) => r.description)).toEqual([
      'Adjustment: =HYPERLINK("x")',
      'Voice (TTS) usage',
      'Call hold',
      'Call charge',
      'Call hold',
      'Wallet recharge',
    ]);
    expect(rows[0]?.createdBy).toEqual({ id: admin.user._id.toString(), name: admin.user.name });
    expect(res.body.meta).toEqual({ hasMore: false, nextCursor: null });
    expect(rows[0]).not.toHaveProperty('idempotencyKey');
    const charges = await get('/api/v1/wallet/ledger?type=call_charge,tts_charge&status=captured');
    expect(charges.body.data.map((r: { description: string }) => r.description)).toEqual([
      'Voice (TTS) usage',
      'Call charge',
    ]);
    expect((await get('/api/v1/wallet/ledger?refType=usage')).body.data).toHaveLength(1);
    expect((await get('/api/v1/wallet/ledger?status=held')).body.data).toHaveLength(1);
    expect((await get('/api/v1/wallet/ledger?from=2099-01-01T00:00:00Z')).body.data).toHaveLength(
      0,
    );
    for (const q of [
      'type=nope',
      'status=x',
      'cursor=!!',
      'cursor=abc',
      'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
      'limit=101',
      'x=1',
    ]) {
      expect((await get(`/api/v1/wallet/ledger?${q}`)).status, q).toBe(422);
    }
    expect((await get('/api/v1/wallet/ledger', agent)).status).toBe(403);
  });

  it('pages with a stable cursor even when timestamps are equal', async () => {
    const x = await createTestAccount();
    const xo = await x.addUser('owner');
    const at = new Date('2026-10-01T10:00:00Z');
    await LedgerEntryModel.collection.insertMany(
      Array.from({ length: 7 }, (_, i) => ({
        accountId: x.account._id,
        type: 'topup',
        direction: 'credit',
        status: 'captured',
        amountMicros: RUPEE,
        currency: 'INR',
        ref: { type: 'manual', id: String(i) },
        idempotencyKey: `p${i}`,
        createdAt: at,
        updatedAt: at,
      })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(
        `/api/v1/wallet/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        xo,
      );
      seen.push(...res.body.data.map((r: { id: string }) => r.id));
      cursor = res.body.meta.nextCursor as string | null;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('returns one entry with its breakdown; other accounts get 404', async () => {
    const res = await get(`/api/v1/wallet/ledger/${chargeId}`);
    expect(res.body.data).toMatchObject({
      type: 'call_charge',
      status: 'captured',
      amountMicros: 5 * RUPEE,
      breakdown: { billableSeconds: 120, telephonyMicros: 2 * RUPEE, aiMicros: 3 * RUPEE },
      ref: { type: 'simulator', id: 'c1' },
    });
    expect(res.body.data.holdId).toMatch(/^[a-f0-9]{24}$/);
    expect((await get(`/api/v1/wallet/ledger/${chargeId}`, otherOwner)).status).toBe(404);
    expect((await get(`/api/v1/wallet/ledger/${new Types.ObjectId().toString()}`)).status).toBe(
      404,
    );
    expect((await get('/api/v1/wallet/ledger/nope')).status).toBe(422);
  });

  it('exports a CSV (BOM, account timezone, signed amounts, injection-safe)', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const res = await get(`/api/v1/wallet/ledger/export?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="ledger-${today}-${today}.csv"`,
    );
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'date,description,type,direction,status,amount_inr,balance_after_inr,ref_type,ref_id,note',
    );
    expect(lines).toHaveLength(7);
    expect(lines[1]).toMatch(
      new RegExp(
        `^${today} \\d{2}:\\d{2}:\\d{2},Wallet recharge,topup,credit,captured,1000\\.00,1000\\.00,topup,seed,$`,
      ),
    );
    expect(text).toContain(',Call charge,call_charge,debit,captured,-5.00,995.00,simulator,c1,');
    expect(text).toContain(`"Adjustment: =HYPERLINK(""x"")"`); // starts with a letter: safe
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('refuses long ranges and too many rows', async () => {
    expect((await get('/api/v1/wallet/ledger/export?from=2025-01-01&to=2026-01-02')).status).toBe(
      422,
    );
    expect((await get('/api/v1/wallet/ledger/export?from=2026-01-02&to=2026-01-01')).status).toBe(
      422,
    );
    expect((await get('/api/v1/wallet/ledger/export?from=2026-1-1&to=2026-01-02')).status).toBe(
      422,
    );
    const limits = BILLING_LIMITS as { ledgerExportMaxRows: number };
    const before = limits.ledgerExportMaxRows;
    limits.ledgerExportMaxRows = 1;
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
        new Date(),
      );
      const res = await get(`/api/v1/wallet/ledger/export?from=${today}&to=${today}`);
      expect(res.status).toBe(422);
      expect(res.body.error.details[0].message).toMatch(/narrow/);
    } finally {
      limits.ledgerExportMaxRows = before;
    }
  });
});

describe('GET /wallet/usage', () => {
  it('groups by IST day, zero-fills and splits call / AI / TTS / other', async () => {
    const x = await createTestAccount({ timezone: 'Asia/Kolkata' });
    const xo = await x.addUser('viewer');
    const row = (createdAt: string, extra: Record<string, unknown>) => ({
      accountId: x.account._id,
      direction: 'debit',
      status: 'captured',
      currency: 'INR',
      ref: { type: 'simulator', id: createdAt },
      idempotencyKey: createdAt + JSON.stringify(extra),
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      ...extra,
    });
    await LedgerEntryModel.collection.insertMany([
      row('2026-10-08T18:29:59Z', {
        type: 'call_charge',
        amountMicros: 10 * RUPEE,
        breakdown: { aiMicros: 4 * RUPEE, ttsMicros: RUPEE },
      }),
      row('2026-10-08T18:30:00Z', { type: 'ai_charge', amountMicros: 2 * RUPEE }),
      row('2026-10-09T05:00:00Z', { type: 'tts_charge', amountMicros: RUPEE }),
      row('2026-10-09T06:00:00Z', { type: 'recording_charge', amountMicros: 3 * RUPEE }),
      row('2026-10-09T07:00:00Z', {
        type: 'call_charge',
        amountMicros: 6 * RUPEE,
        breakdown: null,
      }),
      {
        ...row('2026-10-09T08:00:00Z', { type: 'call_charge', amountMicros: 99 * RUPEE }),
        status: 'held',
      },
    ]);
    const res = await get('/api/v1/wallet/usage?from=2026-10-07&to=2026-10-09', xo);
    expect(res.status).toBe(200);
    expect(res.body.data.timezone).toBe('Asia/Kolkata');
    expect(res.body.data.series).toEqual([
      {
        date: '2026-10-07',
        callMicros: 0,
        aiMicros: 0,
        ttsMicros: 0,
        otherMicros: 0,
        totalMicros: 0,
      },
      {
        date: '2026-10-08',
        callMicros: 5 * RUPEE,
        aiMicros: 4 * RUPEE,
        ttsMicros: RUPEE,
        otherMicros: 0,
        totalMicros: 10 * RUPEE,
      },
      {
        date: '2026-10-09',
        callMicros: 6 * RUPEE,
        aiMicros: 2 * RUPEE,
        ttsMicros: RUPEE,
        otherMicros: 3 * RUPEE,
        totalMicros: 12 * RUPEE,
      },
    ]);
    expect(res.body.data.totals).toEqual({
      callMicros: 11 * RUPEE,
      aiMicros: 6 * RUPEE,
      ttsMicros: 2 * RUPEE,
      otherMicros: 3 * RUPEE,
      totalMicros: 22 * RUPEE,
    });
  });

  it('defaults to this month and validates the range', async () => {
    const res = await get('/api/v1/wallet/usage');
    expect(res.status).toBe(200);
    expect(res.body.data.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(res.body.data.series.length).toBeGreaterThanOrEqual(1);
    expect((await get('/api/v1/wallet/usage?from=2026-10-09&to=2026-10-01')).status).toBe(422);
    expect((await get('/api/v1/wallet/usage?from=2024-01-01&to=2026-01-01')).status).toBe(422);
    expect((await get('/api/v1/wallet/usage?from=2099-01-01')).status).toBe(422); // after today's default `to`
  });
});

describe('billing profile', () => {
  const valid = {
    legalName: 'Test Finance Pvt Ltd',
    email: 'Billing@Example.com',
    addressLine1: '12, MI Road',
    city: 'Jaipur',
    stateCode: '08',
    pin: '302001',
    gstin: makeGstin('08').toLowerCase(),
  };

  it('starts empty, saves, audits field names only', async () => {
    const empty = await get('/api/v1/billing/profile', viewer);
    expect(empty.body.data).toEqual({ profile: null, complete: false, sellerStateCode: '08' });
    const res = await request(app).put('/api/v1/billing/profile').set(auth(owner)).send(valid);
    expect(res.status).toBe(200);
    expect(res.body.data.complete).toBe(true);
    expect(res.body.data.profile).toMatchObject({
      email: 'billing@example.com',
      gstin: makeGstin('08'),
      addressLine2: null,
    });
    const audit = await AuditLogModel.findOne({
      accountId: acc(),
      action: 'billing.profile_updated',
    }).lean();
    expect(audit?.meta).toEqual({
      fields: ['legalName', 'email', 'addressLine1', 'city', 'stateCode', 'pin', 'gstin'],
    });
    expect(JSON.stringify(audit)).not.toContain(makeGstin('08'));
    await request(app)
      .put('/api/v1/billing/profile')
      .set(auth(admin))
      .send({ ...valid, gstin: null });
    expect((await AccountModel.findById(acc()).lean())?.billing?.gstin).toBeNull();
  });

  it('validates every field', async () => {
    const put = (patch: Record<string, unknown>) =>
      request(app)
        .put('/api/v1/billing/profile')
        .set(auth(owner))
        .send({ ...valid, ...patch });
    const message = async (patch: Record<string, unknown>) =>
      ((await put(patch)).body.error.details as { path: string; message: string }[])[0]?.message;
    expect(await message({ legalName: 'आशा फाइनेंस' })).toMatch(/English letters/);
    expect(await message({ pin: '012345' })).toMatch(/6 digits/);
    expect(await message({ stateCode: '25' })).toMatch(/state code/);
    expect(await message({ gstin: makeGstin('27') })).toMatch(/different state/);
    expect(await message({ gstin: `${makeGstin('08').slice(0, 14)}A` })).toMatch(
      /check digit|valid/,
    );
    expect(await message({ gstin: 'ABC' })).toMatch(/valid GSTIN/);
    expect((await put({ email: 'nope' })).status).toBe(422);
    expect((await put({ city: '' })).status).toBe(422);
    expect((await put({ extra: 1 })).status).toBe(422);
  });

  it('guards writes by permission and impersonation; lists GST states', async () => {
    const put = (u: { token: string }) =>
      request(app).put('/api/v1/billing/profile').set(auth(u)).send(valid);
    expect((await put(manager)).status).toBe(403);
    expect((await put(viewer)).status).toBe(403);
    expect((await get('/api/v1/billing/profile', agent)).status).toBe(403);
    const imp = { token: await tokenFor(owner.user, { imp: new Types.ObjectId().toString() }) };
    expect((await put(imp)).body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const states = await get('/api/v1/billing/states', agent);
    expect(states.status).toBe(200);
    expect(states.body.data).toContainEqual({ code: '08', name: 'Rajasthan' });
    expect((await get('/api/v1/billing/profile', otherOwner)).body.data.profile).toBeNull();
  });
});
