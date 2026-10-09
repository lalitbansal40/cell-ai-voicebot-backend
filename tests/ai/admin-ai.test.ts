import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { chargeUsage, credit } from '../../src/core/billing/engine';
import { invalidateRateCardCache } from '../../src/core/billing/rates';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const RUPEE = 1_000_000;
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const CARD = {
  callPerMinuteMicros: 2 * RUPEE,
  pulseSeconds: 30,
  aiPerMinuteMicros: 3 * RUPEE,
  ttsPer1kCharsMicros: RUPEE,
  commissionBps: 0,
  billUnansweredAttempts: false,
};

let platform: TestAccount;
let superadmin: TestUser;
let customer: TestAccount;
let owner: TestUser;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-${Date.now()}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  customer = await createTestAccount({ name: 'AI Customer' });
  owner = await customer.addUser('owner');
  await credit({
    accountId: customer.account._id,
    type: 'adjustment',
    amountMicros: 100 * RUPEE,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${customer.account._id.toString()}`,
  });
});

describe('AI prices on rate cards', () => {
  it('the default card takes and returns the AI prices, audited as a diff', async () => {
    const res = await request(app)
      .put('/api/v1/admin/rate-cards/default')
      .set(auth(superadmin))
      .send({
        ...CARD,
        aiTextPer1kTokensMicros: 300_000,
        embeddingPer1kTokensMicros: 20_000,
        note: 'AI prices',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      aiTextPer1kTokensMicros: 300_000,
      embeddingPer1kTokensMicros: 20_000,
    });
    const got = await request(app).get('/api/v1/admin/rate-cards/default').set(auth(superadmin));
    expect(got.body.data.aiTextPer1kTokensMicros).toBe(300_000);
    const log = await AuditLogModel.findOne({ action: 'rate_card.updated' })
      .sort({ _id: -1 })
      .lean();
    expect(log?.meta).toMatchObject({
      changes: {
        aiTextPer1kTokensMicros: { from: 200_000, to: 300_000 },
        embeddingPer1kTokensMicros: { from: 10_000, to: 20_000 },
      },
    });
    // omitted AI prices are carried over
    const carry = await request(app)
      .put('/api/v1/admin/rate-cards/default')
      .set(auth(superadmin))
      .send({ ...CARD, commissionBps: 10, note: 'carry over' });
    expect(carry.status, JSON.stringify(carry.body)).toBe(200);
    expect(carry.body.data.aiTextPer1kTokensMicros).toBe(300_000);
    const owners = await request(app).get('/api/v1/wallet/rates').set(auth(owner));
    expect(owners.body.data).toMatchObject({
      aiTextPer1kTokensMicros: 300_000,
      embeddingPer1kTokensMicros: 20_000,
    });
  });

  it.each([-1, 1_000_000_001, 1.5])('refuses %s', async (value) => {
    const res = await request(app)
      .put('/api/v1/admin/rate-cards/default')
      .set(auth(superadmin))
      .send({ ...CARD, aiTextPer1kTokensMicros: value, note: 'bad price' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual([
      'body.aiTextPer1kTokensMicros',
    ]);
  });

  it('a new account price applies to the very next playground turn', async () => {
    const agent = await request(app)
      .post('/api/v1/agents')
      .set(auth(owner))
      .send({ name: 'Priced' });
    const session = await request(app)
      .post(`/api/v1/agents/${agent.body.data.id}/playground/sessions`)
      .set(auth(owner))
      .send({});
    const say = () =>
      request(app)
        .post(
          `/api/v1/agents/${agent.body.data.id}/playground/sessions/${session.body.data.id}/messages`,
        )
        .set(auth(owner))
        .send({ text: 'hello', clientTurnId: randomUUID() });
    const first = await say();
    const tokens = first.body.data.turn.inputTokens + first.body.data.turn.outputTokens;
    expect(first.body.data.turn.costMicros).toBe(Math.ceil((tokens * 300_000) / 1000));

    const card = await request(app)
      .post(`/api/v1/admin/accounts/${customer.account._id.toString()}/rate-cards`)
      .set(auth(superadmin))
      .send({
        ...CARD,
        aiTextPer1kTokensMicros: 5 * RUPEE,
        embeddingPer1kTokensMicros: 0,
        note: 'expensive AI',
      });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    const second = await say();
    const t2 = second.body.data.turn.inputTokens + second.body.data.turn.outputTokens;
    expect(second.body.data.turn.costMicros).toBe(Math.ceil((t2 * 5 * RUPEE) / 1000));
  });
});

describe('/admin/ai/config', () => {
  it('shows the provider and switches, never the key', async () => {
    const res = await request(app).get('/api/v1/admin/ai/config').set(auth(superadmin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      provider: 'fake',
      textModels: ['gpt-4.1-mini'],
      defaultTextModel: 'gpt-4.1-mini',
      embeddingModel: 'text-embedding-3-small',
      mockApisEnabled: true,
      allowPrivateHosts: true,
      openaiKeyConfigured: false,
    });
    const keyed = buildTestApp({ OPENAI_API_KEY: 'test-not-real-key' });
    const withKey = await request(keyed).get('/api/v1/admin/ai/config').set(auth(superadmin));
    expect(withKey.body.data).toMatchObject({ provider: 'openai', openaiKeyConfigured: true });
    expect(withKey.text).not.toContain('test-not-real-key');
  });

  it('is for superadmins only (never while impersonating)', async () => {
    expect((await request(app).get('/api/v1/admin/ai/config').set(auth(owner))).status).toBe(403);
    const imp = {
      token: await tokenFor(superadmin.user, { imp: customer.account._id.toString() }),
    };
    expect((await request(app).get('/api/v1/admin/ai/config').set(auth(imp))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/ai/config')).status).toBe(401);
  });
});

describe('billing summary — AI', () => {
  it('counts playground turns, ingests and tokens of the month', async () => {
    const other = await createTestAccount();
    await credit({
      accountId: other.account._id,
      type: 'adjustment',
      amountMicros: 10 * RUPEE,
      ref: { type: 'manual', id: 'x' },
      idempotencyKey: `f-${other.account._id.toString()}`,
    });
    const charge = (key: string, breakdown: object) =>
      chargeUsage({
        accountId: other.account._id,
        type: 'ai_charge',
        amountMicros: 1000,
        breakdown,
        ref: { type: 'usage', id: key },
        idempotencyKey: key,
      });
    const before = (await request(app).get('/api/v1/admin/billing/summary').set(auth(superadmin)))
      .body.data.ai;
    await charge(`s1-${randomUUID()}`, {
      kind: 'playground',
      inputTokens: 100,
      outputTokens: 20,
      model: 'm',
    });
    await charge(`s2-${randomUUID()}`, {
      kind: 'playground',
      inputTokens: 50,
      outputTokens: 10,
      embeddingTokens: 5,
      model: 'm',
    });
    await charge(`k1-${randomUUID()}`, { kind: 'kb_ingest', embeddingTokens: 400, model: 'e' });
    await LedgerEntryModel.countDocuments(); // settle
    invalidateRateCardCache();
    const res = await request(app).get('/api/v1/admin/billing/summary').set(auth(superadmin));
    expect(res.status).toBe(200);
    expect(res.body.data.ai).toEqual({
      playgroundTurns: before.playgroundTurns + 2,
      kbIngests: before.kbIngests + 1,
      inputTokens: before.inputTokens + 150,
      outputTokens: before.outputTokens + 30,
      embeddingTokens: before.embeddingTokens + 405,
    });
  });
});
