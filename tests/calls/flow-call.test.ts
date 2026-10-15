import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { CALL_LINES } from '../../src/config/limits';
import { createFakeProvider } from '../../src/core/ai';
import { FakeClock } from '../../src/core/voice/clock';
import type { AiStepEnd, AiStepRequest } from '../../src/core/voice/flow-host';
import { FakeStt, FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { FlowNodeStatsModel } from '../../src/db/models/flow-node-stats.model';
import { FlowRunModel } from '../../src/db/models/flow-run.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { flowScript } from '../../src/modules/calls/flow-script';
import { CallRegistry } from '../../src/modules/calls/registry';
import { LOAN_TEXTS } from '../../src/modules/flows/templates';
import { createLogger } from '../../src/shared/logger';
import { addDays, ymdInZone } from '../../src/shared/time';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { answer, ensureRateCard, fund, makeLeg, pumpUntil, talk } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, newFlow, saveGraph } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-flowcall-'));
const prefix = `${uniquePrefix('flowcall')}:`;
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    storage,
    aiProvider: createFakeProvider(),
    aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);
const logLines: string[] = [];
const logger = createLogger(
  { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
);

let server: Server;
let redis: Redis;
let t: TestAccount;
let manager: TestUser;
let flowId: string;
let aiAgentId: string;
let paid: string;
let unpaid: string;
const aiRequests: AiStepRequest[] = [];
let aiEnd: AiStepEnd;

const tomorrowText = () => {
  const [y, m, d] = addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1).split('-');
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
  return `${d ?? ''} ${months[Number(m) - 1] ?? ''} ${y ?? ''}`;
};

beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  redis = (await requireRedis()).client;
  await ensureRateCard();
  t = await createTestAccount({ name: 'Acme Finance' });
  manager = await t.addUser('manager');
  await fund(t.account._id);
  await CustomFieldModel.create([
    { accountId: t.account._id, key: 'amount', label: 'Amount', type: 'currency' },
    { accountId: t.account._id, key: 'due_date', label: 'Due date', type: 'date' },
  ]);
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(manager))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  const agentId = agent.body.data.id as string;
  aiAgentId = agentId;
  const mockUrl = `http://localhost:${String(port)}/api/v1/mock/payment-status?phone={{contact.phone}}`;
  await AiAgentModel.updateOne({ _id: agentId }, { $set: { 'functions.0.url': mockUrl } });
  const created = await request(app)
    .post(FLOWS)
    .set(auth(manager))
    .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
  flowId = created.body.data.id;
  const draft = created.body.data.draft;
  draft.nodes.find((n: { id: string }) => n.id === 'check').config.url = mockUrl;
  await request(app)
    .put(`${FLOWS}/${flowId}/draft`)
    .set(auth(manager))
    .send({ revision: 1, graph: draft });
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
      variables: { amount: 2_500_000_000, due_date: '2026-10-10' },
    });
  paid = (await contact('+919000400012', 'Asha Verma'))._id.toString();
  unpaid = (await contact('+919000400017', 'Ravi Kumar'))._id.toString();
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const env = loadEnv({ MOCK_APIS_ENABLED: 'true' });

const startCall = async (
  contactId: string | null,
  extra: {
    variables?: Record<string, string>;
    testPhone?: string;
    draft?: boolean;
    flow?: string;
  } = {},
) => {
  const clock = new FakeClock(Date.now());
  const tts = new FakeTts();
  const m = new CallManager({
    logger,
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts, storage }),
    storage,
    recordingDir,
    tickets: { issue: () => Promise.resolve({ ticket: 'wst_t', expiresAt: 'x' }) },
    clock,
    scriptFor: (call) =>
      flowScript(call, {
        env,
        secretKey: Buffer.alloc(32, 1),
        extraPorts,
        http: { resolve: () => Promise.resolve(['127.0.0.1']) },
        provider: createFakeProvider(),
        stt: new FakeStt(),
        storage,
        redis,
        now: () => new Date(clock.now()),
        runAi: (req) => {
          aiRequests.push(req);
          return Promise.resolve(aiEnd);
        },
      }),
  });
  const created = await m.createWebCall({
    accountId: t.account._id.toString(),
    userId: manager.user._id.toString(),
    source: {
      kind: 'flow',
      flowId: new Types.ObjectId(extra.flow ?? flowId),
      ...(extra.draft ? { flowVersionRef: 'draft' as const } : {}),
    },
    contactId,
    variables: {},
    manualVariables: extra.variables ?? null,
    testPhone: extra.testPhone ?? null,
  });
  const parts = makeLeg(clock);
  const attached = await m.attach(
    {
      callId: created.callId,
      accountId: t.account._id.toString(),
      userId: manager.user._id.toString(),
    },
    parts.leg,
  );
  expect(attached).toEqual({ ok: true });
  answer(parts.leg);
  return { clock, tts, callId: created.callId, ...parts };
};

const callOf = async (id: string) => (await CallModel.findById(id).lean<CallDoc>()) as CallDoc;
const lines = async (callId: string) =>
  (await TranscriptTurnModel.find({ callId }).sort({ seq: 1 }).lean()).map(
    (x) => `${x.speaker}:${x.text}`,
  );
const waitForLine = async (
  c: Awaited<ReturnType<typeof startCall>>,
  text: string,
  maxMs = 60_000,
) => {
  const heard = async () => (await lines(c.callId)).some((l) => l.endsWith(text));
  if (await pumpUntil(c.clock, c.leg, heard, maxMs)) return;
  throw new Error(
    `never heard "${text}" in ${JSON.stringify(await lines(c.callId))} ${JSON.stringify(await callOf(c.callId).then((x) => [x.status, x.endReason]))}`,
  );
};
const waitForEnd = async (c: Awaited<ReturnType<typeof startCall>>, maxMs = 90_000) => {
  const done = async () => ['completed', 'failed'].includes((await callOf(c.callId)).status);
  if (await pumpUntil(c.clock, c.leg, done, maxMs)) return callOf(c.callId);
  throw new Error(`call never ended: ${JSON.stringify(await lines(c.callId))}`);
};
const press = (c: Awaited<ReturnType<typeof startCall>>, digit: string) =>
  c.leg.receiveControl({ type: 'call.dtmf', digit });

const GREETING =
  'Namaste Asha Verma, main Acme Finance ki taraf se ek AI assistant bol rahi hoon. Aapki ₹2,500.00 ki EMI 10 Oct 2026 ko due thi.';

describe('flow calls — Loan recovery live (fake voice)', () => {
  it('paid contact: greeting with name + amount, press 1 → API → thanks → Paid', async () => {
    const c = await startCall(paid);
    await waitForLine(c, LOAN_TEXTS.menu);
    press(c, '1');
    const call = await waitForEnd(c);
    expect(call).toMatchObject({
      status: 'completed',
      endReason: 'hangup_node',
      disposition: 'paid',
    });
    expect(await lines(c.callId)).toEqual([
      `bot:${CALL_LINES.recordingNotice}`,
      `bot:${GREETING}`,
      `bot:${LOAN_TEXTS.menu}`,
      'customer:[1]',
      `bot:${LOAN_TEXTS.paid}`,
      `bot:${LOAN_TEXTS.bye}`,
    ]);
    const run = await FlowRunModel.findById(call.flowRunId).lean();
    expect(run).toMatchObject({
      mode: 'call',
      status: 'ended',
      endReason: 'hangup_node',
      versionRef: 1,
    });
    expect(run?.callId?.toString()).toBe(c.callId);
    expect(await FlowNodeStatsModel.exists({ flowId, mode: 'call', nodeId: 'menu' })).toBeTruthy();
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'node_entered',
        'data.nodeId': 'check',
      }),
    ).toBeTruthy();
    expect(call.variables.name).toBe('Asha Verma');
    expect(JSON.stringify(call)).not.toContain('9000400012');
    expect(await redis.exists(`call:state:${c.callId}`)).toBe(0);
  });

  it('unpaid contact: press 1 → not in record → AI step (promise) → promise saved → bye', async () => {
    aiEnd = {
      outcome: {
        promiseToPay: {
          date: addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1),
          amountMicros: null,
        },
      },
      reason: 'outcome',
      turns: 2,
      aiSeconds: 12,
      language: 'hi',
    };
    const c = await startCall(unpaid);
    await waitForLine(c, LOAN_TEXTS.menu);
    press(c, '1');
    const call = await waitForEnd(c);
    expect(call).toMatchObject({
      status: 'completed',
      disposition: 'promise_to_pay',
      languageDetected: 'hi',
    });
    const heard = await lines(c.callId);
    expect(heard).toContain(`bot:${LOAN_TEXTS.notFound}`);
    expect(heard).toContain(
      `bot:Aapka promise ${tomorrowText()} ke liye save ho gaya hai. Dhanyavaad!`,
    );
    expect(heard.at(-1)).toBe(`bot:${LOAN_TEXTS.bye}`);
    const req = aiRequests.at(-1) as AiStepRequest;
    expect(req.nodeId).toBe('ai');
    expect(req.values.name).toBe('Ravi Kumar');
    expect(req.turns[0]?.role).toBe('assistant'); // the opening line the engine already said
    expect(call.metrics.aiSeconds).toBeGreaterThanOrEqual(12);
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'ai_session_ended',
        'data.reason': 'outcome',
      }),
    ).toBeTruthy();
  });

  it('press 2 → SMS queued + link sent → Promise to pay (keys pressed during the prompt count)', async () => {
    const c = await startCall(paid);
    await waitForLine(c, GREETING);
    press(c, '2'); // while the menu prompt is still playing
    const call = await waitForEnd(c);
    expect(call.disposition).toBe('promise_to_pay');
    expect((call.outcome as { messages: unknown[] }).messages).toHaveLength(1);
    expect(await lines(c.callId)).toContain(`bot:${LOAN_TEXTS.linkSent}`);
  });

  it('silence ×3 → callback; wrong keys ×3 → callback', async () => {
    const quiet = await startCall(paid);
    const call = await waitForEnd(quiet, 120_000);
    expect(call.disposition).toBe('callback_requested');
    expect(await lines(quiet.callId)).toContain(`bot:${LOAN_TEXTS.callback}`);
    const wrong = await startCall(paid);
    for (let i = 0; i < 3; i += 1) {
      await waitForLine(wrong, LOAN_TEXTS.menu);
      press(wrong, '9');
      await talk(wrong.clock, wrong.leg, 500);
    }
    expect((await waitForEnd(wrong)).disposition).toBe('callback_requested');
  });

  it('a key during an interruptible prompt cuts it (barge-in); the customer hanging up ends the run', async () => {
    const c = await startCall(paid);
    await waitForLine(c, CALL_LINES.recordingNotice); // the greeting starts next
    await vi.waitFor(() => expect(c.leg.playing).toBe(true));
    await talk(c.clock, c.leg, 1000);
    press(c, '2');
    await waitForLine(c, LOAN_TEXTS.linkSent);
    const greeting = await TranscriptTurnModel.findOne({ callId: c.callId, text: GREETING }).lean();
    expect(greeting?.interrupted).toBe(true);
    expect((await waitForEnd(c)).metrics.bargeIns).toBeGreaterThanOrEqual(1);
    const hang = await startCall(paid);
    await waitForLine(hang, GREETING);
    hang.leg.receiveControl({ type: 'call.hangup' });
    const ended = await waitForEnd(hang);
    expect(ended.endReason).toBe('customer_hangup');
    await vi.waitFor(async () =>
      expect(
        (await FlowRunModel.findById((await callOf(hang.callId)).flowRunId).lean())?.endReason,
      ).toBe('customer_hangup'),
    );
  });

  it('a draft call runs the draft graph and keeps it on the run', async () => {
    const c = await startCall(paid, { draft: true });
    await waitForLine(c, LOAN_TEXTS.menu);
    press(c, '1');
    const call = await waitForEnd(c);
    expect(call.disposition).toBe('paid');
    const run = await FlowRunModel.findById(call.flowRunId).lean();
    expect(run?.versionRef).toBe('draft');
    expect(run?.graph).toBeTruthy();
  });

  /** A draft flow saved through the API (positions filled in). */
  const draftFlow = async (
    name: string,
    nodes: { id: string; type: string; config?: Record<string, unknown> }[],
    edges: [string, string, string][],
    settings: Record<string, unknown> = {},
  ) => {
    const flow = await newFlow(app, manager, name);
    const saved = await saveGraph(app, manager, flow.id, flow.revision, {
      schemaVersion: 1,
      nodes: nodes.map((n, i) => ({ config: {}, position: { x: 0, y: i * 100 }, ...n })),
      edges: edges.map(([source, sourceHandle, target]) => ({
        id: `e_${source}_${sourceHandle}`,
        source,
        sourceHandle,
        target,
      })),
      variables: [],
      ...(Object.keys(settings).length ? { settings } : {}),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return flow.id;
  };
  const upload = async (file: string, name: string) => {
    const res = await request(app)
      .post('/api/v1/flow-audio')
      .set(auth(manager))
      .field('name', name)
      .attach('file', readFileSync(path.resolve(__dirname, '../fixtures/audio', file)), file);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  };

  it('library audio plays on the call: WAV and MP3 decoded from storage; a file deleted mid-call → fallback text', async () => {
    const wav = await upload('tone-8k-mono.wav', 'Welcome tone');
    const mp3 = await upload('cbr-128k.mp3', 'Music');
    const gone = await upload('tone-8k-mono.wav', 'Gone');
    const id = await draftFlow(
      'Audio flow',
      [
        { id: 'start', type: 'start' },
        { id: 'a1', type: 'play_audio', config: { audioId: wav } },
        { id: 'a2', type: 'play_audio', config: { audioId: mp3 } },
        { id: 'a3', type: 'play_audio', config: { audioId: gone, fallbackText: 'Audio missing' } },
        { id: 'bye', type: 'hangup', config: { text: 'Bye' } },
      ],
      [
        ['start', 'next', 'a1'],
        ['a1', 'next', 'a2'],
        ['a2', 'next', 'a3'],
        ['a3', 'next', 'bye'],
      ],
    );
    const c = await startCall(paid, { draft: true, flow: id });
    await FlowAudioModel.deleteOne({ _id: gone }); // removed while the call runs
    const call = await waitForEnd(c);
    expect(call.endReason).toBe('hangup_node');
    expect(await lines(c.callId)).toEqual([
      `bot:${CALL_LINES.recordingNotice}`,
      'bot:Welcome tone',
      'bot:Music',
      'bot:Audio missing',
      'bot:Bye',
    ]);
  });

  it('the flow max duration ends the call and the run as max_duration', async () => {
    const id = await draftFlow(
      'Long waits',
      [
        { id: 'start', type: 'start' },
        { id: 'w1', type: 'wait', config: { seconds: 40 } },
        { id: 'w2', type: 'wait', config: { seconds: 40 } },
        { id: 'bye', type: 'hangup', config: { text: 'Bye' } },
      ],
      [
        ['start', 'next', 'w1'],
        ['w1', 'next', 'w2'],
        ['w2', 'next', 'bye'],
      ],
      { maxDurationSec: 60 },
    );
    const c = await startCall(paid, { draft: true, flow: id });
    const call = await waitForEnd(c, 120_000);
    expect(call.endReason).toBe('max_duration');
    // the limit fires at 60 s; the fake clock keeps ticking while the call settles
    expect(call.durationSec).toBeGreaterThanOrEqual(60);
    expect(call.durationSec).toBeLessThanOrEqual(65);
    await vi.waitFor(async () =>
      expect((await FlowRunModel.findById(call.flowRunId).lean())?.endReason).toBe('max_duration'),
    );
  });

  it('press 3 goes to the AI step; an API step answering 500 takes the failure edge', async () => {
    aiEnd = { outcome: {}, reason: 'end_call', turns: 1, aiSeconds: 3, language: null };
    const before = aiRequests.length;
    const three = await startCall(paid);
    await waitForLine(three, LOAN_TEXTS.menu);
    press(three, '3');
    await waitForEnd(three);
    expect(aiRequests.length).toBe(before + 1);
    expect(
      await CallEventModel.exists({
        callId: three.callId,
        type: 'node_exited',
        'data.handle': 'key_k3',
      }),
    ).toBeTruthy();

    const port = extraPorts[0] ?? 0;
    const created = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({
        name: 'Loan recovery 500',
        templateKey: 'loan_recovery',
        agentIds: { ai: aiAgentId },
      });
    const draft = created.body.data.draft;
    draft.nodes.find((n: { id: string }) => n.id === 'check').config.url =
      `http://localhost:${String(port)}/api/v1/mock/http-status/500`;
    const saved = await saveGraph(app, manager, created.body.data.id, 1, draft);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const broken = await startCall(paid, { draft: true, flow: created.body.data.id });
    await waitForLine(broken, LOAN_TEXTS.menu);
    press(broken, '1');
    await waitForEnd(broken);
    expect(
      await CallEventModel.exists({
        callId: broken.callId,
        type: 'node_exited',
        'data.nodeId': 'check',
        'data.handle': 'failure',
      }),
    ).toBeTruthy();
    expect(aiRequests.length).toBe(before + 2);
  });

  it('typed values instead of a contact; logs never carry texts, phones or digits', async () => {
    const c = await startCall(null, {
      variables: { name: 'Typed Name' },
      testPhone: '+919000400012',
    });
    await waitForLine(c, LOAN_TEXTS.menu);
    press(c, '1');
    const call = await waitForEnd(c);
    expect(call.disposition).toBe('paid'); // the API step saw the test phone
    expect(await lines(c.callId)).toContain(`bot:${LOAN_TEXTS.paid}`);
    const logs = logLines.join('\n');
    for (const secret of [
      LOAN_TEXTS.menu,
      LOAN_TEXTS.paid,
      'Asha Verma',
      'Typed Name',
      '9000400012',
      '9000400017',
      '[1]',
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});
