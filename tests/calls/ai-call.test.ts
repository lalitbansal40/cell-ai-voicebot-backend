import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { CALL_LINES } from '../../src/config/limits';
import { createFakeProvider } from '../../src/core/ai';
import { outgoingPolicy } from '../../src/core/ai/ip-guard';
import { AiVoiceController } from '../../src/core/voice/ai-session';
import { FakeClock } from '../../src/core/voice/clock';
import { ChatVoiceProvider, FakeStt, FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AgentUsageModel } from '../../src/db/models/agent-usage.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { CallRegistry } from '../../src/modules/calls/registry';
import { createScriptFactory } from '../../src/modules/calls/scripts';
import { LOAN_TEXTS } from '../../src/modules/flows/templates';
import { createLogger } from '../../src/shared/logger';
import { addDays, ymdInZone } from '../../src/shared/time';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { answer, ensureRateCard, fund, makeLeg, pumpUntil } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-aicall-'));
const prefix = `${uniquePrefix('aicall')}:`;
const extraPorts: number[] = [];
const resolve = () => Promise.resolve(['127.0.0.1']);
const app = buildTestApp(
  {},
  { storage, aiProvider: createFakeProvider(), aiHttp: { extraPorts, resolve } },
);
const env = loadEnv({ MOCK_APIS_ENABLED: 'true' });
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
let port: number;
let t: TestAccount;
let manager: TestUser;
let agentId: string;
let paid: string;
let unpaid: string;

const OPENING =
  'Namaste Asha Verma ji, main Acme Finance se bol raha hoon. Kya aapse do minute baat ho sakti hai?';
const CLOSING = 'Aapke samay ke liye dhanyavaad. Aapka din shubh ho.';

beforeAll(async () => {
  server = app.listen(0);
  port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  redis = (await requireRedis()).client;
  await ensureRateCard();
  t = await createTestAccount({ name: 'Acme Finance' });
  manager = await t.addUser('manager');
  await fund(t.account._id);
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(manager))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  agentId = agent.body.data.id as string;
  await AiAgentModel.updateOne(
    { _id: agentId },
    {
      $set: {
        'functions.0.url': `http://localhost:${String(port)}/api/v1/mock/payment-status?phone={{contact.phone}}`,
        'builtInTools.endCall.enabled': true,
        'builtInTools.transferToHuman': { enabled: true, phone: '+919876543210', message: null },
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
  paid = (await contact('+919000400012', 'Asha Verma'))._id.toString();
  unpaid = (await contact('+919000400017', 'Ravi Kumar'))._id.toString();
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((done) => server.close(() => done()));
});

const startCall = async (
  contactId: string | null,
  extra: { variables?: Record<string, string>; testPhone?: string; flowId?: string } = {},
) => {
  const clock = new FakeClock(Date.now());
  const tts = new FakeTts();
  const stt = new FakeStt();
  const provider = createFakeProvider();
  const http = { extraPorts, resolve, policy: outgoingPolicy(env, extraPorts) };
  const m = new CallManager({
    logger,
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts, storage }),
    storage,
    recordingDir,
    tickets: { issue: () => Promise.resolve({ ticket: 'wst_t', expiresAt: 'x' }) },
    clock,
    scriptFor: createScriptFactory({
      env,
      secretKey: Buffer.alloc(32, 1),
      extraPorts,
      http: { resolve },
      provider,
      stt,
      storage,
      redis,
      now: () => new Date(clock.now()),
      controller: new AiVoiceController({
        voice: new ChatVoiceProvider('fake', stt, tts),
        ai: provider,
        embeddingModel: 'text-embedding-3-small',
        secretKey: Buffer.alloc(32, 1),
        http,
        now: () => new Date(clock.now()),
      }),
    }),
  });
  const created = await m.createWebCall({
    accountId: t.account._id.toString(),
    userId: manager.user._id.toString(),
    source: extra.flowId
      ? { kind: 'flow', flowId: new Types.ObjectId(extra.flowId) }
      : { kind: 'agent', agentId: new Types.ObjectId(agentId) },
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
  return { clock, callId: created.callId, manager: m, ...parts };
};
type Live = Awaited<ReturnType<typeof startCall>>;

const callOf = async (id: string) => (await CallModel.findById(id).lean<CallDoc>()) as CallDoc;
const lines = async (callId: string) =>
  (await TranscriptTurnModel.find({ callId }).sort({ seq: 1 }).lean()).map(
    (x) => `${x.speaker}:${x.text}`,
  );
const heard = async (c: Live, text: string, maxMs = 60_000) => {
  const ok = await pumpUntil(
    c.clock,
    c.leg,
    async () => (await lines(c.callId)).some((l) => l.includes(text)),
    maxMs,
  );
  if (!ok) throw new Error(`never heard "${text}" in ${JSON.stringify(await lines(c.callId))}`);
};
const ended = async (c: Live, maxMs = 120_000) => {
  const done = async () => ['completed', 'failed'].includes((await callOf(c.callId)).status);
  if (!(await pumpUntil(c.clock, c.leg, done, maxMs))) {
    throw new Error(`call never ended: ${JSON.stringify(await lines(c.callId))}`);
  }
  return callOf(c.callId);
};
const say = (c: Live, text: string) => c.leg.receiveControl({ type: 'call.say_text', text });

describe('agent-only calls — live AI on the fake voice pipeline', () => {
  it('opening line → "maine payment kar diya" → payment API → paid reply → "bye" → closing line, call ends', async () => {
    const c = await startCall(paid);
    await heard(c, OPENING);
    say(c, 'maine payment kar diya');
    await heard(c, 'Dhanyavaad! Hamare record mein');
    say(c, 'theek hai bye');
    const call = await ended(c);
    expect(call).toMatchObject({ status: 'completed', endReason: 'agent_end_call' });
    const all = await lines(c.callId);
    expect(all[0]).toBe(`bot:${CALL_LINES.recordingNotice}`);
    expect(all[1]).toBe(`bot:${OPENING}`);
    expect(all).toContain('customer:maine payment kar diya');
    expect(all.at(-1)).toBe(`bot:${CLOSING}`);
    expect(call.metrics.aiSeconds).toBeGreaterThan(0);
    expect(call.languageDetected).toBe('hi');
    expect(call.metrics.latency.samples).toBeGreaterThanOrEqual(2);
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'ai_function_result',
        'data.name': 'check_payment_status',
        'data.ok': true,
      }),
    ).toBeTruthy();
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'ai_session_ended',
        'data.reason': 'end_call',
      }),
    ).toBeTruthy();
  });

  it('unpaid: "kal tak de dunga" → promise tomorrow (IST) saved → Promise to pay', async () => {
    const c = await startCall(unpaid);
    await heard(c, 'Ravi Kumar ji');
    say(c, 'abhi nahi hua, kal tak de dunga');
    await pumpUntil(c.clock, c.leg, async () => (await lines(c.callId)).length >= 5);
    say(c, 'bye');
    const call = await ended(c);
    const tomorrow = addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1);
    expect(call.disposition).toBe('promise_to_pay');
    expect((call.outcome as { promiseToPay: { date: string } }).promiseToPay.date).toBe(tomorrow);
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'ai_outcome',
        'data.promiseToPay': true,
      }),
    ).toBeTruthy();
  });

  it('"insaan se baat karni hai" → transfer prompt in the browser → connected ends the call transferred', async () => {
    const c = await startCall(paid);
    await heard(c, OPENING);
    say(c, 'mujhe insaan se baat karni hai');
    await pumpUntil(c.clock, c.leg, () =>
      Promise.resolve(c.json.some((m) => m.type === 'call.transfer')),
    );
    expect(c.json.find((m) => m.type === 'call.transfer')).toEqual({
      type: 'call.transfer',
      phoneLast4: '3210',
    });
    c.leg.receiveControl({ type: 'call.transfer_result', result: 'connected' });
    const call = await ended(c);
    expect(call.endReason).toBe('transferred');
  });

  it('English words get an English reply and the call language is en', async () => {
    const c = await startCall(paid);
    await heard(c, OPENING);
    say(c, 'I have paid, the payment is done');
    await heard(c, 'Thank you! Our records show');
    c.leg.receiveControl({ type: 'call.hangup' });
    const call = await ended(c);
    expect(call.languageDetected).toBe('en');
    expect(call.endReason).toBe('customer_hangup');
  });

  it('a failing payment API → the "can\'t check" reply, the call goes on', async () => {
    await AiAgentModel.updateOne(
      { _id: agentId },
      {
        $set: { 'functions.0.url': `http://localhost:${String(port)}/api/v1/mock/http-status/500` },
      },
    );
    try {
      const c = await startCall(paid);
      await heard(c, OPENING);
      say(c, 'maine payment kar diya');
      await heard(c, 'Maaf kijiye, abhi check nahi ho pa raha.');
      expect((await callOf(c.callId)).status).toBe('in_progress');
      say(c, 'bye');
      await ended(c);
    } finally {
      await AiAgentModel.updateOne(
        { _id: agentId },
        {
          $set: {
            'functions.0.url': `http://localhost:${String(port)}/api/v1/mock/payment-status?phone={{contact.phone}}`,
          },
        },
      );
    }
  });

  it('typing while the bot speaks cuts it (barge-in) and the words still count', async () => {
    const c = await startCall(paid);
    await heard(c, CALL_LINES.recordingNotice);
    await pumpUntil(c.clock, c.leg, () => Promise.resolve(c.leg.playing), 10_000);
    await pumpUntil(c.clock, c.leg, () => Promise.resolve(true), 1000);
    say(c, 'maine payment kar diya');
    await heard(c, 'Dhanyavaad! Hamare record mein');
    const opening = await TranscriptTurnModel.findOne({ callId: c.callId, text: OPENING }).lean();
    expect(opening?.interrupted).toBe(true);
    c.leg.receiveControl({ type: 'call.hangup' });
    const call = await ended(c);
    expect(call.metrics.bargeIns).toBeGreaterThanOrEqual(1);
  });

  it('silence: the "Hello?" prompt twice, then the call ends (no response)', async () => {
    const c = await startCall(paid);
    const call = await ended(c, 200_000);
    const all = await lines(c.callId);
    expect(all.filter((l) => l === `bot:${CALL_LINES.silenceHi}`)).toHaveLength(2);
    expect(call.metrics.silencePrompts).toBe(2);
    expect(call.endReason).toBe('agent_end_call');
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'ai_session_ended',
        'data.reason': 'no_response',
      }),
    ).toBeTruthy();
  });

  it('typed values instead of a contact (test phone reaches the function); logs stay clean', async () => {
    const c = await startCall(null, {
      variables: { name: 'Typed Name' },
      testPhone: '+919000400012',
    });
    await heard(c, 'Namaste Typed Name ji');
    say(c, 'maine payment kar diya');
    await heard(c, 'Dhanyavaad! Hamare record mein');
    c.leg.receiveControl({ type: 'call.hangup' });
    await ended(c);
    const logs = logLines.join('\n');
    for (const secret of [
      OPENING,
      'maine payment kar diya',
      'Typed Name',
      'Asha Verma',
      '9000400012',
      '9000400017',
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('flow calls with a live AI step', () => {
  it('Loan recovery: press 3 → the agent talks → "kal tak de dunga" → promise → the flow says the saved date', async () => {
    const created = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({
        name: 'Loan recovery live AI',
        templateKey: 'loan_recovery',
        agentIds: { ai: agentId },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const flowId = created.body.data.id as string;
    const published = await request(app)
      .post(`${FLOWS}/${flowId}/publish`)
      .set(auth(manager))
      .send({ revision: 1 });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const c = await startCall(unpaid, { flowId });
    await heard(c, LOAN_TEXTS.menu);
    c.leg.receiveControl({ type: 'call.dtmf', digit: '3' });
    await heard(c, 'Ravi Kumar ji'); // the agent's opening line (said by the flow step)
    say(c, 'abhi nahi, kal tak de dunga');
    const tomorrow = addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1);
    const [y, m, d] = tomorrow.split('-');
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
    await heard(
      c,
      `Aapka promise ${d ?? ''} ${months[Number(m) - 1] ?? ''} ${y ?? ''} ke liye save ho gaya hai.`,
    );
    const call = await ended(c);
    expect(call).toMatchObject({
      status: 'completed',
      disposition: 'promise_to_pay',
      languageDetected: 'hi',
    });
    expect(call.metrics.aiSeconds).toBeGreaterThan(0);
    expect(
      await CallEventModel.exists({
        callId: c.callId,
        type: 'ai_session_ended',
        'data.reason': 'outcome',
      }),
    ).toBeTruthy();
  });
});

describe('agent-only calls — caps and wallet', () => {
  it('a reached daily cap speaks the cap line and ends the call', async () => {
    await AiAgentModel.updateOne(
      { _id: agentId },
      { $set: { 'limits.dailySpendCapMicros': 1_000 } },
    );
    const day = ymdInZone(new Date(), 'Asia/Kolkata');
    await AgentUsageModel.create({
      accountId: t.account._id,
      agentId,
      day,
      month: day.slice(0, 7),
      spentMicros: 5_000,
    });
    try {
      const c = await startCall(paid);
      const call = await ended(c);
      const agent = await AiAgentModel.findById(agentId).lean();
      expect(await lines(c.callId)).toContain(`bot:${agent?.fallback.capReached ?? ''}`);
      expect(call.endReason).toBe('ai_failed');
    } finally {
      await AiAgentModel.updateOne({ _id: agentId }, { $set: { 'limits.dailySpendCapMicros': 0 } });
    }
  });

  it('an empty wallet (balance all on hold) speaks the wallet line and ends wallet_empty', async () => {
    const other = await createTestAccount({ name: 'Broke Co' });
    const owner = await other.addUser('manager');
    await fund(other.account._id);
    const copy = await AiAgentModel.findById(agentId).lean();
    const { _id: _ignored, ...rest } = copy as NonNullable<typeof copy>;
    const agent = await AiAgentModel.create({ ...rest, accountId: other.account._id });
    const clock = new FakeClock(Date.now());
    const tts = new FakeTts();
    const stt = new FakeStt();
    const m = new CallManager({
      logger,
      registry: new CallRegistry(redis, prefix),
      tts: new TtsCache({ tts, storage }),
      storage,
      recordingDir,
      tickets: { issue: () => Promise.resolve({ ticket: 'wst_t', expiresAt: 'x' }) },
      clock,
      scriptFor: createScriptFactory({
        env,
        secretKey: Buffer.alloc(32, 1),
        provider: createFakeProvider(),
        stt,
        storage,
        controller: new AiVoiceController({
          voice: new ChatVoiceProvider('fake', stt, tts),
          ai: createFakeProvider(),
          embeddingModel: 'x',
          secretKey: Buffer.alloc(32, 1),
          http: { policy: outgoingPolicy(env, extraPorts) },
        }),
      }),
    });
    const created = await m.createWebCall({
      accountId: other.account._id.toString(),
      userId: owner.user._id.toString(),
      source: { kind: 'agent', agentId: agent._id },
      contactId: null,
      variables: {},
    });
    // everything left is on hold: AI usage is prepaid (balance − holds must be > 0)
    const wallet = await WalletModel.findOne({ accountId: other.account._id }).lean();
    await WalletModel.updateOne(
      { accountId: other.account._id },
      { $set: { holdMicros: wallet?.balanceMicros ?? 0 } },
    );
    const parts = makeLeg(clock);
    await m.attach(
      {
        callId: created.callId,
        accountId: other.account._id.toString(),
        userId: owner.user._id.toString(),
      },
      parts.leg,
    );
    answer(parts.leg);
    const c = { clock, callId: created.callId, manager: m, ...parts };
    const call = await ended(c);
    expect(await lines(c.callId)).toContain(`bot:${agent.fallback.walletEmpty}`);
    expect(call.endReason).toBe('wallet_empty');
  });
});
