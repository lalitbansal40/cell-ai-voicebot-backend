import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AI_LIMITS } from '../../src/config/limits';
import { createFakeProvider } from '../../src/core/ai';
import { credit } from '../../src/core/billing/engine';
import { AgentPlaygroundSessionModel } from '../../src/db/models/agent-playground-session.model';
import { AgentUsageModel } from '../../src/db/models/agent-usage.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { purgePlaygroundSessions } from '../../src/modules/ai-agents/maintenance';
import { addDays, ymdInZone } from '../../src/shared/time';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const provider = createFakeProvider();
const chat = vi.spyOn(provider, 'chat');
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    aiProvider: provider,
    aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

let server: Server;
let t: TestAccount;
let manager: TestUser;
let viewer: TestUser;
let agentId: string;
let evenContact: string;
let oddContact: string;

const sessions = (id = agentId) => `/api/v1/agents/${id}/playground/sessions`;
const say = (
  sid: string,
  text: string,
  user = manager,
  clientTurnId: string = randomUUID(),
  id = agentId,
) =>
  request(app)
    .post(`${sessions(id)}/${sid}/messages`)
    .set(auth(user))
    .send({ text, clientTurnId });
const open = async (body: object, user = manager, id = agentId) => {
  const res = await request(app).post(sessions(id)).set(auth(user)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; turns: { text: string }[] } & Record<string, unknown>;
};

beforeAll(async () => {
  // the real app serves the mock payment API the template function calls
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  t = await createTestAccount({ name: 'Acme Finance' });
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
  await credit({
    accountId: t.account._id,
    type: 'adjustment',
    amountMicros: 100_000_000,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${t.account._id.toString()}`,
  });
  const created = await request(app)
    .post('/api/v1/agents')
    .set(auth(manager))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  agentId = created.body.data.id;
  await AiAgentModel.updateOne(
    { _id: agentId },
    {
      $set: {
        'functions.0.url': `http://localhost:${port}/api/v1/mock/payment-status?phone={{contact.phone}}`,
        allowedVariables: ['name', 'phone_last4'],
      },
    },
  );
  const contact = (phone: string, name: string) =>
    ContactModel.create({
      accountId: t.account._id,
      phoneE164: phone,
      name,
      source: { type: 'manual' },
    });
  evenContact = (await contact('+919000000002', 'Asha Verma'))._id.toString();
  oddContact = (await contact('+919000000001', 'Ravi Kumar'))._id.toString();
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('playground — "Done when"', () => {
  it('paid: "maine pay kar diya" checks the mock API and thanks the customer', async () => {
    const s = await open({ contactId: evenContact });
    expect(s.variables).toEqual({ name: 'Asha Verma', phone_last4: '0002' });
    expect(s.turns[0]?.text).toBe(
      'Namaste Asha Verma ji, main Acme Finance se bol raha hoon. Kya aapse do minute baat ho sakti hai?',
    );
    expect(JSON.stringify(s)).not.toContain('9000000002');

    const res = await say(s.id, 'maine pay kar diya');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.turn.toolCalls).toEqual([
      expect.objectContaining({ name: 'check_payment_status', kind: 'custom', ok: true }),
    ]);
    expect(res.body.data.turn.text).toContain(
      'Dhanyavaad! Hamare record mein aapka ₹2500 ka payment',
    );
    expect(res.body.data).toMatchObject({
      status: 'active',
      replay: false,
      userTurn: { role: 'user', text: 'maine pay kar diya' },
    });
    expect(res.body.data.turn.billing).toBe('charged');

    const row = await LedgerEntryModel.findOne({
      idempotencyKey: { $regex: `^aiturn:${s.id}:` },
    }).lean();
    expect(row).toMatchObject({ type: 'ai_charge', ref: { type: 'usage', id: s.id } });
    expect(row?.breakdown).toMatchObject({ kind: 'playground', model: 'gpt-4.1-mini' });
    expect(row?.breakdown?.inputTokens).toBeGreaterThan(0);
    expect(await AgentUsageModel.countDocuments({ agentId })).toBe(1);
  });

  it('unpaid → promise: outcome saved with tomorrow (IST)', async () => {
    const s = await open({ contactId: oddContact });
    const unpaid = await say(s.id, 'maine payment kar diya hai');
    expect(unpaid.body.data.turn.text).toContain(
      'Abhi tak hamare record mein payment nahi dikh raha',
    );
    const promise = await say(s.id, 'kal tak de dunga');
    const tomorrow = addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1);
    expect(promise.body.data.outcome).toMatchObject({
      promiseToPay: { date: tomorrow, amountMicros: null },
    });
    const stored = await request(app).get(`${sessions()}/${s.id}`).set(auth(viewer));
    expect(stored.body.data.turns).toHaveLength(5);
    expect(stored.body.data.outcome.promiseToPay.date).toBe(tomorrow);
    expect(stored.body.data.costMicros).toBeGreaterThan(0);
  });

  it('a test phone reaches functions only', async () => {
    const s = await open({
      variables: { name: 'Tester', other: 'dropped' },
      testPhone: '+919000000004',
    });
    expect(s).toMatchObject({
      hasTestPhone: true,
      variables: { name: 'Tester', phone_last4: '0004' },
    });
    const res = await say(s.id, 'maine pay kar diya');
    expect(res.body.data.turn.text).toContain('Dhanyavaad');
    const got = await request(app).get(`${sessions()}/${s.id}`).set(auth(manager));
    expect(JSON.stringify(got.body)).not.toContain('9000000004');
    expect(
      JSON.stringify(
        await request(app)
          .get(sessions())
          .set(auth(manager))
          .then((r) => r.text),
      ),
    ).not.toContain('9000000004');
  });
});

describe('playground — sessions and messages', () => {
  it('replays the same clientTurnId without a new model call or charge', async () => {
    const s = await open({ variables: { name: 'Asha' } });
    const id = randomUUID();
    chat.mockClear();
    const first = await say(s.id, 'hello', manager, id);
    const calls = chat.mock.calls.length;
    const again = await say(s.id, 'hello', manager, id);
    expect(again.body.data).toMatchObject({ replay: true, turn: { id: first.body.data.turn.id } });
    expect(chat.mock.calls.length).toBe(calls);
    expect(await LedgerEntryModel.countDocuments({ idempotencyKey: `aiturn:${s.id}:${id}` })).toBe(
      1,
    );
    expect((await say(s.id, 'x', manager, 'not-a-uuid')).status).toBe(422);
  });

  it('ends on goodbye; ended sessions refuse messages; reset starts fresh', async () => {
    const s = await open({ contactId: evenContact });
    const bye = await say(s.id, 'ok bye');
    expect(bye.body.data).toMatchObject({ status: 'ended', outcome: { endRequested: true } });
    const refused = await say(s.id, 'hello?');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT_INVALID_STATE');
    const reset = await request(app).post(`${sessions()}/${s.id}/reset`).set(auth(manager));
    expect(reset.status).toBe(201);
    expect(reset.body.data).toMatchObject({
      status: 'active',
      contactId: evenContact,
      variables: s.variables,
    });
    expect(reset.body.data.id).not.toBe(s.id);
    expect(reset.body.data.turns).toHaveLength(1);
  });

  it('lists the latest sessions (all / mine)', async () => {
    const other = await t.addUser('admin');
    await open({}, other);
    const all = await request(app).get(sessions()).set(auth(viewer));
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThan(3);
    expect(all.body.data[0]).toMatchObject({ userId: other.user._id.toString(), status: 'active' });
    const mine = await request(app).get(`${sessions()}?mine=true`).set(auth(other));
    expect(mine.body.data).toHaveLength(1);
  });

  it('a spend cap set to stop refuses with 422 and keeps no user turn', async () => {
    const capped = await request(app)
      .post('/api/v1/agents')
      .set(auth(manager))
      .send({ name: 'Capped' });
    await AiAgentModel.updateOne(
      { _id: capped.body.data.id },
      { $set: { limits: { dailySpendCapMicros: 1, monthlySpendCapMicros: 0, onCap: 'stop' } } },
    );
    const s = await open({}, manager, capped.body.data.id);
    await AgentUsageModel.create({
      accountId: t.account._id,
      agentId: new Types.ObjectId(capped.body.data.id as string),
      day: ymdInZone(new Date(), 'Asia/Kolkata'),
      month: ymdInZone(new Date(), 'Asia/Kolkata').slice(0, 7),
      spentMicros: 5,
      turns: 1,
    });
    const res = await say(s.id, 'hello', manager, randomUUID(), capped.body.data.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AI_SPEND_CAP_REACHED');
    // blank agents have no opening line: the session stays empty
    const stored = await AgentPlaygroundSessionModel.findById(s.id).lean();
    expect(stored?.turns).toHaveLength(s.turns.length);
    expect(s.turns).toHaveLength(0);
  });

  it('is rate limited per user (30 / min)', async () => {
    const busy = await t.addUser('owner');
    const s = await open({}, busy);
    for (let i = 0; i < AI_LIMITS.playgroundPerMinute; i += 1) {
      expect((await say(s.id, `msg ${i}`, busy)).status).toBe(200);
    }
    const limited = await say(s.id, 'one more', busy);
    expect(limited.status).toBe(429);
  });
});

describe('playground — permissions, isolation, purge', () => {
  it('viewers read but cannot start or post; impersonation and suspended are blocked', async () => {
    const s = await open({});
    expect((await request(app).get(`${sessions()}/${s.id}`).set(auth(viewer))).status).toBe(200);
    expect((await request(app).post(sessions()).set(auth(viewer)).send({})).status).toBe(403);
    expect((await say(s.id, 'hi', viewer)).status).toBe(403);
    const owner = await t.addUser('owner');
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    const res = await say(s.id, 'hi', imp as TestUser);
    expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await request(app).post(sessions()).set(auth(imp)).send({})).body.error.code).toBe(
      'AUTH_IMPERSONATION_BLOCKED',
    );

    const suspended = await createTestAccount({ status: 'suspended' });
    const so = await suspended.addUser('owner');
    const agent = await AiAgentModel.create({
      accountId: suspended.account._id,
      name: 'S',
      model: { textModel: 'gpt-4.1-mini' },
    });
    expect(
      (await request(app).post(sessions(agent._id.toString())).set(auth(so)).send({})).status,
    ).toBe(403);
  });

  it("another account's agent or session is 404", async () => {
    const s = await open({});
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    expect((await request(app).get(`${sessions()}/${s.id}`).set(auth(o))).status).toBe(404);
    expect((await request(app).get(sessions()).set(auth(o))).status).toBe(404);
    expect((await say(s.id, 'hi', o)).status).toBe(404);
    expect((await request(app).post(`${sessions()}/${s.id}/reset`).set(auth(o))).status).toBe(404);
    // a session id under another agent of the same account
    const second = await request(app)
      .post('/api/v1/agents')
      .set(auth(manager))
      .send({ name: 'Second' });
    expect(
      (
        await request(app)
          .get(`${sessions(second.body.data.id)}/${s.id}`)
          .set(auth(manager))
      ).status,
    ).toBe(404);
    const foreign = await ContactModel.create({
      accountId: other.account._id,
      phoneE164: '+919000000009',
      source: { type: 'manual' },
    });
    expect(
      (
        await request(app)
          .post(sessions())
          .set(auth(manager))
          .send({ contactId: foreign._id.toString() })
      ).status,
    ).toBe(404);
  });

  it('the purge job deletes expired sessions', async () => {
    const s = await open({});
    await AgentPlaygroundSessionModel.updateOne(
      { _id: s.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const { deleted } = await purgePlaygroundSessions();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await AgentPlaygroundSessionModel.findById(s.id)).toBeNull();
  });
});
