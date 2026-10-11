import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { credit } from '../../src/core/billing/engine';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowNodeStatsModel } from '../../src/db/models/flow-node-stats.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { LOAN_TEXTS } from '../../src/modules/flows/templates';
import { addDays, ymdInZone } from '../../src/shared/time';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    aiProvider: createFakeProvider(),
    aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);

let server: Server;
let t: TestAccount;
let manager: TestUser;
let flowId: string;
let paid: string;
let unpaid: string;

const tomorrow = () => {
  const ymd = addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1);
  const [y, m, d] = ymd.split('-');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return { ymd, text: `${d ?? ''} ${months[Number(m) - 1] ?? ''} ${y ?? ''}` };
};

type Entry = { role: string; kind: string; text: string };
const start = async (contactId: string) => {
  const res = await request(app)
    .post(`${FLOWS}/${flowId}/simulations`)
    .set(auth(manager))
    .send({ version: 'published', contactId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    run: {
      id: string;
      status: string;
      waiting: { kind: string } | null;
      outcome: Record<string, unknown>;
    };
    added: Entry[];
  };
};
const send = async (runId: string, kind: string, value?: string) => {
  const res = await request(app)
    .post(`${FLOWS}/${flowId}/simulations/${runId}/inputs`)
    .set(auth(manager))
    .send({ clientInputId: randomUUID(), kind, ...(value === undefined ? {} : { value }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    run: {
      id: string;
      status: string;
      endReason: string | null;
      waiting: { kind: string } | null;
      outcome: Record<string, unknown>;
    };
    added: Entry[];
  };
};
const bot = (added: Entry[]) => added.filter((e) => e.role === 'bot').map((e) => e.text);

beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  t = await createTestAccount({ name: 'Acme Finance' });
  manager = await t.addUser('manager');
  await credit({
    accountId: t.account._id,
    type: 'adjustment',
    amountMicros: 100_000_000,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${t.account._id.toString()}`,
  });
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(manager))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  const agentId = agent.body.data.id as string;
  const mockUrl = `http://localhost:${String(port)}/api/v1/mock/payment-status?phone={{contact.phone}}`;
  await AiAgentModel.updateOne(
    { _id: agentId },
    { $set: { 'functions.0.url': mockUrl, 'builtInTools.transferToHuman.enabled': true } },
  );
  const created = await request(app)
    .post(FLOWS)
    .set(auth(manager))
    .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
  flowId = created.body.data.id;
  const draft = created.body.data.draft;
  draft.nodes.find((n: { id: string }) => n.id === 'check').config.url = mockUrl;
  const saved = await request(app)
    .put(`${FLOWS}/${flowId}/draft`)
    .set(auth(manager))
    .send({ revision: 1, graph: draft });
  expect(saved.status).toBe(200);
  const published = await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(manager))
    .send({ revision: 2 });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  const contact = (phone: string, name: string) =>
    ContactModel.create({
      accountId: t.account._id,
      phoneE164: phone,
      name,
      source: { type: 'manual' },
    });
  paid = (await contact('+919000400012', 'Asha Verma'))._id.toString();
  unpaid = (await contact('+919000400017', 'Ravi Kumar'))._id.toString();
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('simulator — Loan recovery "Done when" (API level)', () => {
  it('greets with the disclosure and waits on the keypad menu', async () => {
    const s = await start(paid);
    expect(bot(s.added)).toEqual([
      'Namaste Asha Verma, main Acme Finance ki taraf se ek AI assistant bol rahi hoon. Aapki  ki EMI  ko due thi.',
      LOAN_TEXTS.menu,
    ]);
    expect(s.run.waiting).toMatchObject({
      kind: 'dtmf',
      keys: [{ key: '1' }, { key: '2' }, { key: '3' }],
    });
  });

  it('press 1, paid contact → API check → thanks → ended "paid"', async () => {
    const s = await start(paid);
    const r = await send(s.run.id, 'dtmf', '1');
    expect(bot(r.added)).toEqual([LOAN_TEXTS.paid, LOAN_TEXTS.bye]);
    expect(r.run).toMatchObject({
      status: 'ended',
      endReason: 'hangup_node',
      outcome: { disposition: 'paid' },
    });
  });

  it('press 1, unpaid contact → not found → AI → "kal tak de dunga" → promise branch', async () => {
    const s = await start(unpaid);
    const r1 = await send(s.run.id, 'dtmf', '1');
    expect(bot(r1.added)[0]).toBe(LOAN_TEXTS.notFound);
    expect(r1.run.waiting).toMatchObject({ kind: 'ai' });
    const r2 = await send(s.run.id, 'speech', 'kal tak de dunga');
    const date = tomorrow();
    expect(bot(r2.added)).toEqual([
      `Theek hai, ${date.text} tak ka promise note kar liya.`,
      `Aapka promise ${date.text} ke liye save ho gaya hai. Dhanyavaad!`,
      LOAN_TEXTS.bye,
    ]);
    expect(r2.run.outcome).toMatchObject({
      disposition: 'promise_to_pay',
      promiseToPay: { date: date.ymd },
    });
  });

  it('press 2 → SMS queued + link sent → promise to pay', async () => {
    const s = await start(unpaid);
    const r = await send(s.run.id, 'dtmf', '2');
    expect(r.added.find((e) => e.kind === 'message')?.text).toBe(
      'Acme Finance: Aapki EMI ka payment link https://pay.example.com/',
    );
    expect(bot(r.added)).toEqual([LOAN_TEXTS.linkSent, LOAN_TEXTS.bye]);
    expect(r.run.outcome).toMatchObject({
      disposition: 'promise_to_pay',
      messages: [{ channel: 'sms' }],
    });
  });

  it('press 3 → AI → "insaan se baat" → transfer → connected', async () => {
    const s = await start(unpaid);
    const r1 = await send(s.run.id, 'dtmf', '3');
    expect(r1.run.waiting).toMatchObject({ kind: 'ai' });
    const r2 = await send(s.run.id, 'speech', 'mujhe kisi insaan se baat karni hai');
    expect(bot(r2.added)).toContain(LOAN_TEXTS.transfer);
    expect(r2.run.waiting).toMatchObject({ kind: 'transfer', transferPhoneLast4: '0000' });
    const r3 = await send(s.run.id, 'transfer_result', 'connected');
    expect(r3.run).toMatchObject({
      status: 'ended',
      endReason: 'transferred',
      outcome: { transfer: { result: 'connected' } },
    });
  });

  it('silence ×3 and wrong keys ×3 → callback branch', async () => {
    for (const [kind, value] of [
      ['no_input', undefined],
      ['dtmf', '8'],
    ] as const) {
      const s = await start(paid);
      await send(s.run.id, kind, value);
      await send(s.run.id, kind, value);
      const last = await send(s.run.id, kind, value);
      expect(bot(last.added)).toEqual([LOAN_TEXTS.callback, LOAN_TEXTS.bye]);
      expect(last.run.outcome.disposition).toBe('callback_requested');
    }
  });

  it('AI turns are billed (flow simulator) and node stats are counted', async () => {
    const rows = await LedgerEntryModel.find({
      accountId: t.account._id,
      type: 'ai_charge',
    }).lean();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.breakdown?.kind === 'flow_simulator')).toBe(true);
    const stats = await request(app).get(`${FLOWS}/${flowId}/stats?version=1`).set(auth(manager));
    const menu = (
      stats.body.data as { nodeId: string; entered: number; exits: Record<string, number> }[]
    ).find((s) => s.nodeId === 'menu');
    expect(menu?.entered).toBeGreaterThanOrEqual(7);
    expect(menu?.exits).toMatchObject({ key_k1: expect.any(Number), key_k2: 1, key_k3: 1 });
    expect(await FlowNodeStatsModel.countDocuments({ flowId })).toBeGreaterThan(5);
  });
});
