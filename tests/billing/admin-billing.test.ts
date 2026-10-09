import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { callCharge, holdEstimate } from '../../src/core/billing/pricing';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const RUPEE = 1_000_000;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let platform: TestAccount;
let superadmin: TestUser;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-${Date.now()}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

let n = 0;
const customer = async () => {
  n += 1;
  const t = await createTestAccount({ name: `Billing Co ${n}` });
  const owner = await t.addUser('owner');
  const viewer = await t.addUser('viewer');
  const agent = await t.addUser('agent');
  return { t, id: t.account._id.toString(), owner, viewer, agent };
};

const admin = {
  get: (url: string) => request(app).get(url).set(auth(superadmin.token)),
  post: (url: string, body: object = {}, key?: string) => {
    const r = request(app).post(url).set(auth(superadmin.token));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  },
  put: (url: string, body: object) => request(app).put(url).set(auth(superadmin.token)).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(url).set(auth(superadmin.token)).send(body),
  delete: (url: string, body: object = {}) =>
    request(app).delete(url).set(auth(superadmin.token)).send(body),
};

const CARD = {
  callPerMinuteMicros: 2 * RUPEE,
  pulseSeconds: 30,
  aiPerMinuteMicros: 3 * RUPEE,
  ttsPer1kCharsMicros: RUPEE,
  commissionBps: 1000,
  billUnansweredAttempts: false,
};

const credit = (id: string, amountMicros: number, key = `k-${Math.random()}`) =>
  admin.post(
    `/api/v1/admin/accounts/${id}/wallet/adjustments`,
    { direction: 'credit', amountMicros, reason: 'Opening credit' },
    key,
  );

describe('guard', () => {
  it('refuses customers (even owners), anonymous callers and impersonating superadmins', async () => {
    const c = await customer();
    const routes: [string, string][] = [
      ['get', '/api/v1/admin/rate-cards/default'],
      ['put', '/api/v1/admin/rate-cards/default'],
      ['get', '/api/v1/admin/rate-cards/default/history'],
      ['get', `/api/v1/admin/accounts/${c.id}/rate-cards`],
      ['post', `/api/v1/admin/accounts/${c.id}/rate-cards`],
      ['delete', `/api/v1/admin/accounts/${c.id}/rate-cards`],
      ['get', `/api/v1/admin/accounts/${c.id}/wallet`],
      ['patch', `/api/v1/admin/accounts/${c.id}/wallet`],
      ['get', `/api/v1/admin/accounts/${c.id}/ledger`],
      ['post', `/api/v1/admin/accounts/${c.id}/wallet/adjustments`],
      ['post', `/api/v1/admin/accounts/${c.id}/billing/simulated-calls`],
      ['get', '/api/v1/admin/billing/config'],
      ['get', '/api/v1/admin/billing/summary'],
      ['get', '/api/v1/admin/payments'],
      ['get', '/api/v1/admin/payment-events'],
    ];
    const imp = await admin.post(`/api/v1/admin/accounts/${c.id}/impersonate`);
    expect(imp.status).toBe(200);
    const impToken = (imp.body as { data: { accessToken: string } }).data.accessToken;
    for (const [method, url] of routes) {
      const call = (token?: string) => {
        const r = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(
          url,
        );
        return token ? r.set(auth(token)) : r;
      };
      expect((await call(c.owner.token).send({})).status, `${method} ${url}`).toBe(403);
      expect((await call(impToken).send({})).status, `${method} ${url}`).toBe(403);
      expect((await call().send({})).status, `${method} ${url}`).toBe(401);
    }
    await request(app).post('/api/v1/admin/impersonation/stop').set(auth(impToken));
  });

  it('404s an unknown account and 409s the platform account', async () => {
    const ghost = '0123456789abcdef01234567';
    expect((await admin.get(`/api/v1/admin/accounts/${ghost}/wallet`)).status).toBe(404);
    const res = await admin.get(`/api/v1/admin/accounts/${platform.account._id.toString()}/wallet`);
    expect(res.status).toBe(409);
    expect((await admin.get('/api/v1/admin/accounts/nope/wallet')).status).toBe(422);
  });
});

describe('rate cards', () => {
  it('versions the default card, audits the diff and customers see it at once', async () => {
    const c = await customer();
    // warm the customer's cached card
    expect(
      (await request(app).get('/api/v1/wallet/rates').set(auth(c.owner.token))).body.data,
    ).toMatchObject({ callPerMinuteMicros: DEFAULT_RATE_CARD.callPerMinuteMicros });

    const before = await admin.get('/api/v1/admin/rate-cards/default');
    expect(before.status).toBe(200);
    const put = await admin.put('/api/v1/admin/rate-cards/default', {
      ...DEFAULT_RATE_CARD,
      callPerMinuteMicros: 1_500_000,
      note: 'New telco contract',
    });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({
      accountId: null,
      callPerMinuteMicros: 1_500_000,
      note: 'New telco contract',
      inheritsDefault: false,
    });
    const rates = await request(app).get('/api/v1/wallet/rates').set(auth(c.owner.token));
    expect(rates.body.data).toMatchObject({ callPerMinuteMicros: 1_500_000, source: 'default' });

    const audit = await AuditLogModel.findOne({
      accountId: platform.account._id,
      action: 'rate_card.updated',
    }).lean();
    expect(audit?.actor).toMatchObject({ platform: true });
    expect(audit?.meta).toMatchObject({
      scope: 'default',
      changes: {
        callPerMinuteMicros: { from: DEFAULT_RATE_CARD.callPerMinuteMicros, to: 1_500_000 },
      },
    });

    const history = await admin.get('/api/v1/admin/rate-cards/default/history?limit=1');
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].id).toBe(put.body.data.id);

    // put back so later tests price at the default
    await admin.put('/api/v1/admin/rate-cards/default', DEFAULT_RATE_CARD);
  });

  it('refuses bad values', async () => {
    for (const bad of [
      { ...CARD, pulseSeconds: 45 },
      { ...CARD, commissionBps: 10_001 },
      { ...CARD, callPerMinuteMicros: 1.5 },
      { ...CARD, extra: 1 },
      { ...CARD, note: 'x' },
    ]) {
      expect((await admin.put('/api/v1/admin/rate-cards/default', bad)).status).toBe(422);
    }
  });

  it('overrides one account and goes back to the default, audited on both sides', async () => {
    const c = await customer();
    const other = await customer();
    const created = await admin.post(`/api/v1/admin/accounts/${c.id}/rate-cards`, {
      ...CARD,
      note: 'Pilot pricing',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.effective).toMatchObject({ source: 'account', ...CARD });
    expect(created.body.data.history).toHaveLength(1);
    expect(
      (await request(app).get('/api/v1/wallet/rates').set(auth(c.owner.token))).body.data,
    ).toMatchObject({ source: 'account', callPerMinuteMicros: CARD.callPerMinuteMicros });
    expect(
      (await request(app).get('/api/v1/wallet/rates').set(auth(other.owner.token))).body.data,
    ).toMatchObject({ source: 'default' });
    for (const accountId of [c.t.account._id, platform.account._id]) {
      expect(
        await AuditLogModel.countDocuments({
          accountId,
          action: 'rate_card.updated',
          'target.id': created.body.data.history[0].id,
        }),
      ).toBe(1);
    }

    const back = await admin.delete(`/api/v1/admin/accounts/${c.id}/rate-cards`, {
      note: 'Pilot over',
    });
    expect(back.status).toBe(200);
    expect(back.body.data.effective.source).toBe('default');
    expect(back.body.data.history).toHaveLength(2);
    expect(back.body.data.history[0]).toMatchObject({ inheritsDefault: true, note: 'Pilot over' });
    expect(
      (await request(app).get('/api/v1/wallet/rates').set(auth(c.owner.token))).body.data.source,
    ).toBe('default');
    expect((await admin.delete(`/api/v1/admin/accounts/${c.id}/rate-cards`)).status).toBe(409);

    const list = await admin.get(`/api/v1/admin/accounts/${c.id}/rate-cards?limit=1`);
    expect(list.body.data.history).toHaveLength(1);
  });
});

describe('wallet, credit limit and ledger', () => {
  it('shows the wallet and sets the credit limit (audited, no ledger row)', async () => {
    const c = await customer();
    const wallet = await admin.get(`/api/v1/admin/accounts/${c.id}/wallet`);
    expect(wallet.status).toBe(200);
    expect(wallet.body.data).toMatchObject({
      balanceMicros: 0,
      creditLimitMicros: 0,
      status: 'exhausted',
    });

    const res = await admin.patch(`/api/v1/admin/accounts/${c.id}/wallet`, {
      creditLimitMicros: 500 * RUPEE,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      creditLimitMicros: 500 * RUPEE,
      availableMicros: 500 * RUPEE,
    });
    expect(await LedgerEntryModel.countDocuments({ accountId: c.t.account._id })).toBe(0);
    for (const accountId of [c.t.account._id, platform.account._id]) {
      const a = await AuditLogModel.findOne({
        accountId,
        action: 'wallet.credit_limit_updated',
        'meta.to': 500 * RUPEE,
      }).lean();
      expect(a?.meta).toEqual({ from: 0, to: 500 * RUPEE });
    }
    // same value again → no new audit
    await admin.patch(`/api/v1/admin/accounts/${c.id}/wallet`, { creditLimitMicros: 500 * RUPEE });
    expect(
      await AuditLogModel.countDocuments({
        accountId: c.t.account._id,
        action: 'wallet.credit_limit_updated',
      }),
    ).toBe(1);
    for (const bad of [{ creditLimitMicros: -1 }, { creditLimitMicros: 100_001 * RUPEE }, {}]) {
      expect((await admin.patch(`/api/v1/admin/accounts/${c.id}/wallet`, bad)).status).toBe(422);
    }
  });

  it('lists the ledger of the account with filters', async () => {
    const c = await customer();
    await credit(c.id, 100 * RUPEE);
    await credit(c.id, 50 * RUPEE);
    const res = await admin.get(`/api/v1/admin/accounts/${c.id}/ledger?limit=1&type=adjustment`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ amountMicros: 50 * RUPEE, type: 'adjustment' });
    expect(res.body.meta.hasMore).toBe(true);
    const next = await admin.get(
      `/api/v1/admin/accounts/${c.id}/ledger?limit=1&cursor=${res.body.meta.nextCursor as string}`,
    );
    expect(next.body.data[0].amountMicros).toBe(100 * RUPEE);
  });
});

describe('adjustments', () => {
  it('credits with a reason, audits both accounts and notifies wallet readers only', async () => {
    const c = await customer();
    const res = await credit(c.id, 250 * RUPEE, 'adj-credit-1');
    expect(res.status).toBe(201);
    expect(res.body.data.entry).toMatchObject({
      type: 'adjustment',
      direction: 'credit',
      amountMicros: 250 * RUPEE,
      note: 'Opening credit',
      balanceAfterMicros: 250 * RUPEE,
      createdBy: { id: superadmin.user._id.toString(), name: superadmin.user.name },
    });
    expect(res.body.data.wallet.balanceMicros).toBe(250 * RUPEE);
    for (const accountId of [c.t.account._id, platform.account._id]) {
      const a = await AuditLogModel.findOne({ accountId, action: 'wallet.adjusted' }).lean();
      expect(a?.meta).toEqual({
        direction: 'credit',
        amountMicros: 250 * RUPEE,
        reason: 'Opening credit',
      });
      expect(a?.actor).toMatchObject({ platform: true });
    }
    const notes = await NotificationModel.find({
      accountId: c.t.account._id,
      type: 'wallet.adjusted',
    }).lean();
    const to = notes.map((x) => x.userId.toString()).sort();
    expect(to).toContain(c.owner.user._id.toString());
    expect(to).toContain(c.viewer.user._id.toString());
    expect(to).not.toContain(c.agent.user._id.toString());
    expect(notes[0]?.body).toContain('₹250.00 was added to your wallet');
  });

  it('replays the same key without a second row; a changed body is refused', async () => {
    const c = await customer();
    const first = await credit(c.id, 10 * RUPEE, 'adj-replay');
    const again = await credit(c.id, 10 * RUPEE, 'adj-replay');
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.entry.id).toBe(first.body.data.entry.id);
    expect(await LedgerEntryModel.countDocuments({ accountId: c.t.account._id })).toBe(1);
    const changed = await credit(c.id, 11 * RUPEE, 'adj-replay');
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // the same key against another account is a different request, not a replay
    const d = await customer();
    expect((await credit(d.id, 10 * RUPEE, 'adj-replay')).status).toBe(422);
    expect(
      await AuditLogModel.countDocuments({ accountId: c.t.account._id, action: 'wallet.adjusted' }),
    ).toBe(1);
  });

  it('validates the body and needs the Idempotency-Key header', async () => {
    const c = await customer();
    const url = `/api/v1/admin/accounts/${c.id}/wallet/adjustments`;
    expect(
      (await admin.post(url, { direction: 'credit', amountMicros: RUPEE, reason: 'Opening' }))
        .status,
    ).toBe(422);
    for (const bad of [
      { direction: 'credit', amountMicros: 1, reason: 'Paise only' },
      { direction: 'credit', amountMicros: 0, reason: 'Zero amount' },
      { direction: 'credit', amountMicros: 1_000_001 * RUPEE, reason: 'Too much' },
      { direction: 'credit', amountMicros: RUPEE, reason: 'shrt' },
      { direction: 'refund', amountMicros: RUPEE, reason: 'Wrong way' },
    ]) {
      expect((await admin.post(url, bad, `bad-${Math.random()}`)).status).toBe(422);
    }
  });

  it('debits only what is available unless allowNegative is set', async () => {
    const c = await customer();
    await credit(c.id, 5 * RUPEE);
    const url = `/api/v1/admin/accounts/${c.id}/wallet/adjustments`;
    const refused = await admin.post(
      url,
      { direction: 'debit', amountMicros: 8 * RUPEE, reason: 'Chargeback' },
      'debit-1',
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
    const forced = await admin.post(
      url,
      { direction: 'debit', amountMicros: 8 * RUPEE, reason: 'Chargeback', allowNegative: true },
      'debit-2',
    );
    expect(forced.status).toBe(201);
    expect(forced.body.data.wallet.balanceMicros).toBe(-3 * RUPEE);
    expect(forced.body.data.entry).toMatchObject({
      direction: 'debit',
      balanceAfterMicros: -3 * RUPEE,
    });
    const note = await NotificationModel.findOne({
      accountId: c.t.account._id,
      type: 'wallet.adjusted',
      body: /deducted/,
    }).lean();
    expect(note?.body).toContain('₹8.00 was deducted from your wallet. Reason: Chargeback');
  });
});

describe('simulator', () => {
  const start = (id: string, body: object = {}) =>
    admin.post(`/api/v1/admin/accounts/${id}/billing/simulated-calls`, body);
  const end = (id: string, holdId: string, body: object) =>
    admin.post(`/api/v1/admin/accounts/${id}/billing/simulated-calls/${holdId}/end`, body);

  it('holds, then charges an answered call exactly', async () => {
    const c = await customer();
    await credit(c.id, 100 * RUPEE);
    const s = await start(c.id);
    expect(s.status).toBe(201);
    const held = holdEstimate(DEFAULT_RATE_CARD);
    expect(s.body.data).toMatchObject({ heldMicros: held, rateCard: { source: 'default' } });
    expect(s.body.data.wallet).toMatchObject({
      holdMicros: held,
      availableMicros: 100 * RUPEE - held,
    });
    const root = await LedgerEntryModel.findById(s.body.data.holdId).lean();
    expect(root?.ref.type).toBe('simulator');

    const usage = { answered: true, durationSec: 90, aiSeconds: 90, ttsChars: 1200 };
    const e = await end(c.id, s.body.data.holdId, usage);
    expect(e.status).toBe(200);
    const charge = callCharge(DEFAULT_RATE_CARD, usage).totalMicros;
    expect(e.body.data.outcome).toBe('charged');
    expect(e.body.data.wallet).toMatchObject({
      holdMicros: 0,
      balanceMicros: 100 * RUPEE - charge,
    });
    const captured = (e.body.data.entries as { status: string; amountMicros: number }[]).filter(
      (r) => r.status === 'captured',
    );
    expect(captured).toEqual([expect.objectContaining({ amountMicros: charge })]);
    expect(e.body.data.entries.some((r: { status: string }) => r.status === 'released')).toBe(true);

    // ending again changes nothing
    const twice = await end(c.id, s.body.data.holdId, usage);
    expect(twice.status).toBe(200);
    expect(twice.body.data.wallet.balanceMicros).toBe(100 * RUPEE - charge);
  });

  it('prices a 90 s call without AI at ₹2 (60 s pulses at ₹1 / min)', async () => {
    const c = await customer();
    await credit(c.id, 50 * RUPEE);
    const s = await start(c.id, { estimateMinutes: 1 });
    expect(s.body.data.heldMicros).toBe(holdEstimate(DEFAULT_RATE_CARD, 1));
    const e = await end(c.id, s.body.data.holdId, { answered: true, durationSec: 90 });
    expect(e.body.data.wallet.balanceMicros).toBe(48 * RUPEE);
  });

  it('releases the whole hold for an unanswered call', async () => {
    const c = await customer();
    await credit(c.id, 50 * RUPEE);
    const s = await start(c.id);
    const e = await end(c.id, s.body.data.holdId, { answered: false, durationSec: 20 });
    expect(e.body.data.outcome).toBe('released');
    expect(e.body.data.wallet).toMatchObject({ balanceMicros: 50 * RUPEE, holdMicros: 0 });
    expect(e.body.data.entries).toEqual([
      expect.objectContaining({ status: 'released', releaseReason: 'unanswered' }),
    ]);
  });

  it('charges a long call past its hold (overrun may go below zero)', async () => {
    const c = await customer();
    await credit(c.id, 20 * RUPEE);
    const s = await start(c.id, { estimateMinutes: 1 });
    expect(s.status).toBe(201);
    const usage = { answered: true, durationSec: 30 * 60, aiSeconds: 30 * 60 };
    const e = await end(c.id, s.body.data.holdId, usage);
    const charge = callCharge(DEFAULT_RATE_CARD, usage).totalMicros;
    expect(charge).toBeGreaterThan(s.body.data.heldMicros);
    expect(e.body.data.wallet.balanceMicros).toBe(20 * RUPEE - charge);
    expect(e.body.data.wallet.balanceMicros).toBeLessThan(0);
  });

  it('refuses without money, and 404s other holds', async () => {
    const c = await customer();
    const broke = await start(c.id);
    expect(broke.status).toBe(422);
    expect(broke.body.error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
    const other = await customer();
    await credit(other.id, 50 * RUPEE);
    const s = await start(other.id);
    expect((await end(c.id, s.body.data.holdId, { answered: true, durationSec: 5 })).status).toBe(
      404,
    );
    // a non-simulator ledger row is not a simulated call
    const adj = await LedgerEntryModel.findOne({
      accountId: other.t.account._id,
      type: 'adjustment',
    }).lean();
    expect(
      (await end(other.id, adj!._id.toString(), { answered: true, durationSec: 5 })).status,
    ).toBe(404);
    expect((await end(other.id, s.body.data.holdId, { answered: true })).status).toBe(422);
  });

  it('does not exist when the simulator is disabled (and the config says so)', async () => {
    const on = await admin.get('/api/v1/admin/billing/config');
    expect(on.body.data).toEqual({ simulatorEnabled: true, paymentProvider: 'fake' });
    const off = buildTestApp({ BILLING_SIMULATOR_ENABLED: 'false' });
    const cfg = await request(off).get('/api/v1/admin/billing/config').set(auth(superadmin.token));
    expect(cfg.body.data.simulatorEnabled).toBe(false);
    const c = await customer();
    const res = await request(off)
      .post(`/api/v1/admin/accounts/${c.id}/billing/simulated-calls`)
      .set(auth(superadmin.token))
      .send({});
    expect(res.status).toBe(404);
    const endRes = await request(off)
      .post(`/api/v1/admin/accounts/${c.id}/billing/simulated-calls/0123456789abcdef01234567/end`)
      .set(auth(superadmin.token))
      .send({ answered: true, durationSec: 1 });
    expect(endRes.status).toBe(404);
    expect(
      await WalletModel.countDocuments({ accountId: c.t.account._id, holdMicros: { $gt: 0 } }),
    ).toBe(0);
  });
});
