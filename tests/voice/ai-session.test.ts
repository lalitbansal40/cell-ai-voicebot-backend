import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { CALL_LIMITS, CALL_LINES } from '../../src/config/limits';
import { createFakeProvider, fakeEmbedding } from '../../src/core/ai';
import { outgoingPolicy } from '../../src/core/ai/ip-guard';
import { AiVoiceController, languageOf, type AiSessionEnd } from '../../src/core/voice/ai-session';
import { FakeClock } from '../../src/core/voice/clock';
import { RealtimeVoiceProvider } from '../../src/core/voice/providers';
import { AiAgentModel, type AiAgentDoc } from '../../src/db/models/ai-agent.model';
import { emptyCallMetrics } from '../../src/db/models/call.model';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../src/db/models/knowledge-chunk.model';
import { KnowledgeSourceModel } from '../../src/db/models/knowledge-source.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import type { BotStream, CallIO } from '../../src/modules/calls/session';
import { addDays, ymdInZone } from '../../src/shared/time';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { answer, ensureRateCard, fund, makeLeg, pumpUntil, talk } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { FakeSocket } from '../helpers/fake-socket';
import { useStubServer } from '../helpers/stub-server';

useTestDb();
const stub = useStubServer();
const env = loadEnv({});

let t: TestAccount;
let agent: AiAgentDoc;

beforeAll(async () => {
  await ensureRateCard();
  t = await createTestAccount({ name: 'Acme Finance' });
  await fund(t.account._id);
  agent = (
    await AiAgentModel.create({
      accountId: t.account._id,
      name: 'Live',
      isActive: true,
      model: { textModel: 'gpt-4.1-mini' },
      openingLine: 'Namaste {{name}} ji.',
      allowedVariables: ['name'],
      callBehaviour: {
        maxCallDurationSec: 120,
        silenceTimeoutSec: 5,
        bargeIn: true,
        endCallAfterSilenceRetries: 1,
      },
      functions: [
        {
          name: 'check_payment_status',
          description: 'Payment status',
          method: 'GET',
          url: `${stub.url}/status`,
          parameters: [],
        },
      ],
      builtInTools: {
        endCall: { enabled: true },
        savePromiseToPay: { enabled: true, maxDaysAhead: 15 },
      },
    })
  ).toObject();
});

/** A call IO over a real web leg (streams play through the pacer). */
const fakeIo = (clock: FakeClock) => {
  const { leg } = makeLeg(clock);
  answer(leg);
  const lines: string[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ended: string[] = [];
  const metrics = emptyCallMetrics();
  const cut: string[] = [];
  const answeredAt = clock.now();
  const io = {
    callId: new Types.ObjectId().toString(),
    accountId: t.account._id.toString(),
    leg,
    clock,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    metrics,
    get ended() {
      return ended.length > 0;
    },
    elapsedMs: () => clock.now() - answeredAt,
    say: async (text: string) => {
      lines.push(`bot:${text}`);
      return leg.play(new Int16Array(2400));
    },
    play: () => Promise.resolve({ completed: true, playedMs: 0 }),
    stream: (): BotStream => {
      const plays: Promise<{ completed: boolean; playedMs: number }>[] = [];
      return {
        push: (pcm) => plays.push(leg.play(pcm)),
        finish: async (text) => {
          const r = await Promise.all(plays);
          const result = {
            completed: r.every((x) => x.completed),
            playedMs: r.reduce((n, x) => n + x.playedMs, 0),
          };
          if (!result.completed) cut.push(text);
          if (text) lines.push(`bot:${text}`);
          return result;
        },
      };
    },
    interrupt: () => {
      metrics.bargeIns += 1;
      return leg.clearAudio();
    },
    transcript: (speaker: string, text: string) => lines.push(`${speaker}:${text}`),
    partial: () => undefined,
    event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
    customerDone: () => undefined,
    end: (reason: string) => ended.push(reason),
  } as unknown as CallIO;
  return { io, leg, lines, events, ended, metrics, cut };
};

const deltaOf = (samples: number) =>
  Buffer.from(new Int16Array(samples).fill(1000).buffer).toString('base64');

const start = (
  overrides: Partial<AiAgentDoc> = {},
  options: { mode?: 'flow' | 'agent'; failOpen?: boolean } = {},
) => {
  const clock = new FakeClock(Date.now());
  const socket = new FakeSocket();
  const voice = new RealtimeVoiceProvider({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-realtime-2.1-mini',
    transcribeModel: 'gpt-4o-mini-transcribe',
    connect: () => {
      setImmediate(() =>
        options.failOpen ? socket.emit('error', new Error('refused')) : socket.emit('open'),
      );
      return socket;
    },
  });
  const controller = new AiVoiceController({
    voice,
    ai: createFakeProvider(),
    embeddingModel: 'text-embedding-3-small',
    secretKey: Buffer.alloc(32, 1),
    http: {
      policy: outgoingPolicy(env, [stub.port]),
      resolve: () => Promise.resolve(['127.0.0.1']),
    },
    now: () => new Date(clock.now()),
  });
  const f = fakeIo(clock);
  let audio: ((frame: Int16Array) => void) | null = null;
  let text: ((words: string) => void) | null = null;
  let stop: (() => void) | null = null;
  let result: AiSessionEnd | null = null;
  const done = controller
    .run({
      io: f.io,
      inputs: {
        setAudio: (fn) => (audio = fn),
        setText: (fn) => (text = fn),
        onStop: (fn) => (stop = fn),
      },
      agent: { ...agent, ...overrides },
      sessionId: new Types.ObjectId(),
      company: 'Acme Finance',
      timezone: 'Asia/Kolkata',
      contact: { phone: '+919000400012' },
      values: { name: 'Asha' },
      history: [{ role: 'assistant', text: 'Opening', clientTurnId: null }],
      maxTurns: null,
      mode: options.mode ?? 'flow',
    })
    .then((r) => (result = r));
  const until = (check: () => boolean, ms = 20_000) =>
    pumpUntil(clock, f.leg, () => Promise.resolve(check()), ms);
  return {
    ...f,
    clock,
    socket,
    done,
    until,
    result: () => result,
    feed: (frame: Int16Array) => audio?.(frame),
    type: (words: string) => text?.(words),
    stop: () => stop?.(),
    receive: (events: Record<string, unknown>[]) => {
      for (const e of events) socket.receive(e);
    },
  };
};
type Started = ReturnType<typeof start>;

const reply = (s: Started, words: string, samples = 4800, id = 'item_b') => {
  s.receive([
    { type: 'response.output_audio.delta', response_id: 'r', item_id: id, delta: deltaOf(samples) },
    {
      type: 'response.output_audio_transcript.done',
      response_id: 'r',
      item_id: id,
      transcript: words,
    },
    {
      type: 'response.done',
      response: {
        id: 'r',
        status: 'completed',
        usage: {
          input_token_details: { audio_tokens: 10, text_tokens: 5, cached_tokens: 2 },
          output_token_details: { audio_tokens: 20, text_tokens: 3 },
        },
      },
    },
  ]);
};
const said = (s: Started) => s.socket.sent;
const customer = (s: Started, words: string) =>
  s.receive([
    { type: 'input_audio_buffer.speech_started', audio_start_ms: 0, item_id: 'u' },
    { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 500, item_id: 'u' },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u',
      content_index: 0,
      transcript: words,
    },
  ]);

describe('AiVoiceController — Realtime sessions', () => {
  it('opens with voice instructions and tools; a custom function runs through the secure executor; a promise ends the flow step', async () => {
    stub.next((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"unpaid"}');
    });
    const s = start();
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    const update = said(s).find((e) => e.type === 'session.update') as {
      session: { tools: { name: string }[]; instructions: string };
    };
    expect(update.session.tools.map((x) => x.name)).toEqual(
      expect.arrayContaining(['check_payment_status', 'end_call', 'save_promise_to_pay']),
    );
    expect(update.session.tools.map((x) => x.name)).not.toContain('search_knowledge');
    customer(s, 'maine pay kar diya');
    expect(s.lines).toContain('customer:maine pay kar diya');
    s.receive([
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 'call_1',
        name: 'check_payment_status',
        arguments: '{}',
      },
      { type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } },
    ]);
    await s.until(() =>
      said(s).some(
        (e) =>
          e.type === 'conversation.item.create' &&
          (e.item as { type: string }).type === 'function_call_output',
      ),
    );
    const output = said(s).find(
      (e) => (e.item as { type?: string } | undefined)?.type === 'function_call_output',
    ) as { item: { call_id: string; output: string } };
    expect(output.item.call_id).toBe('call_1');
    expect(output.item.output).toContain('unpaid');
    expect(said(s).at(-1)?.type).toBe('response.create');
    expect(stub.requests.at(-1)?.url).toBe('/status');
    reply(s, 'Payment nahi dikh raha. Kab tak kar paayenge?');
    await s.until(() => s.lines.includes('bot:Payment nahi dikh raha. Kab tak kar paayenge?'));
    expect(s.result()).toBeNull();
    customer(s, 'kal tak');
    const tomorrow = addDays(ymdInZone(new Date(), 'Asia/Kolkata'), 1);
    s.receive([
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r2',
        item_id: 'f2',
        call_id: 'call_2',
        name: 'save_promise_to_pay',
        arguments: JSON.stringify({ date: tomorrow }),
      },
      { type: 'response.done', response: { id: 'r2', status: 'completed', usage: {} } },
    ]);
    await s.until(() => said(s).filter((e) => e.type === 'response.create').length >= 2);
    reply(s, 'Promise note kar liya.');
    await s.until(() => s.result() !== null);
    expect(s.result()).toMatchObject({
      reason: 'outcome',
      turns: 2,
      outcome: { promiseToPay: { date: tomorrow, amountMicros: null } },
      language: 'hi',
    });
    expect(s.metrics.realtime).toMatchObject({
      inputAudioTokens: 20,
      outputAudioTokens: 40,
      cachedTokens: 4,
    });
    expect(s.events.filter((e) => e.type === 'ai_function_result').map((e) => e.data)).toEqual([
      { name: 'check_payment_status', ok: true },
      { name: 'save_promise_to_pay', ok: true },
    ]);
    expect(s.events.some((e) => e.type === 'ai_outcome' && e.data.promiseToPay === true)).toBe(
      true,
    );
    expect(s.socket.closedWith).toBe(1000);
  });

  it('barge-in: customer speech cuts the playing reply and truncates it at the ms heard', async () => {
    const s = start();
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    s.receive([
      {
        type: 'response.output_audio.delta',
        response_id: 'r',
        item_id: 'item_b3',
        delta: deltaOf(24_000 * 3),
      },
    ]);
    await talk(s.clock, s.leg, 1000);
    expect(s.leg.playing).toBe(true);
    s.receive([
      { type: 'input_audio_buffer.speech_started', audio_start_ms: 2000, item_id: 'u3' },
      {
        type: 'response.output_audio_transcript.done',
        response_id: 'r',
        item_id: 'item_b3',
        transcript: 'Ek lamba jawab',
      },
      { type: 'response.done', response: { id: 'r', status: 'cancelled' } },
    ]);
    await s.until(() => said(s).some((e) => e.type === 'conversation.item.truncate'));
    const truncate = said(s).find((e) => e.type === 'conversation.item.truncate') as {
      item_id: string;
      audio_end_ms: number;
    };
    expect(truncate.item_id).toBe('item_b3');
    expect(truncate.audio_end_ms).toBeGreaterThan(500);
    expect(truncate.audio_end_ms).toBeLessThan(2000);
    expect(s.cut).toEqual(['Ek lamba jawab']);
    expect(s.metrics.bargeIns).toBe(1);
    s.stop();
    await s.done;
  });

  it('barge-in off: the customer is not heard while the bot speaks', async () => {
    const s = start({ callBehaviour: { ...agent.callBehaviour, bargeIn: false } });
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    s.receive([
      {
        type: 'response.output_audio.delta',
        response_id: 'r',
        item_id: 'b',
        delta: deltaOf(24_000),
      },
    ]);
    await talk(s.clock, s.leg, 100);
    const before = said(s).filter((e) => e.type === 'input_audio_buffer.append').length;
    s.feed(new Int16Array(480));
    expect(said(s).filter((e) => e.type === 'input_audio_buffer.append').length).toBe(before);
    s.receive([{ type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } }]);
    await s.until(() => !s.leg.playing);
    s.feed(new Int16Array(480));
    expect(said(s).filter((e) => e.type === 'input_audio_buffer.append').length).toBe(before + 1);
    s.type('typed words');
    expect(
      said(s).some(
        (e) => e.type === 'conversation.item.create' && JSON.stringify(e).includes('typed words'),
      ),
    ).toBe(true);
    s.stop();
    await s.done;
  });

  it('search_knowledge answers from the agent knowledge bases and charges the embedding to the call', async () => {
    const kb = await KnowledgeBaseModel.create({
      accountId: t.account._id,
      name: 'Policies',
      version: 1,
      embeddingModel: 'text-embedding-3-small',
    });
    const source = await KnowledgeSourceModel.create({
      accountId: t.account._id,
      kbId: kb._id,
      kind: 'url',
      title: 'Fees',
      url: 'https://x.test',
      chunks: 1,
      status: 'ready',
      version: 1,
    });
    const text = 'Late fee is 500 rupees per month.';
    await KnowledgeChunkModel.create({
      accountId: t.account._id,
      kbId: kb._id,
      sourceId: source._id,
      sourceVersion: 1,
      order: 0,
      title: 'Late fee',
      text,
      embedding: fakeEmbedding('late fee rupees month'),
      dims: fakeEmbedding('x').length,
      model: 'text-embedding-3-small',
    });
    const s = start({
      knowledge: { knowledgeBaseIds: [kb._id], topK: 3, minScoreHundredths: 0 },
    });
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    const update = said(s).find((e) => e.type === 'session.update') as {
      session: { tools: { name: string }[] };
    };
    expect(update.session.tools.map((x) => x.name)).toContain('search_knowledge');
    s.receive([
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 'k1',
        name: 'search_knowledge',
        arguments: '{"query":"late fee per month"}',
      },
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 'k2',
        name: 'search_knowledge',
        arguments: '{"query":',
      },
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 'k3',
        name: 'search_knowledge',
        arguments: '{"query":"  "}',
      },
      { type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } },
    ]);
    await s.until(() => said(s).some((e) => e.type === 'response.create'));
    const outputs = said(s)
      .filter((e) => (e.item as { type?: string } | undefined)?.type === 'function_call_output')
      .map((e) => (e.item as { output: string }).output);
    expect(outputs[0]).toContain(text);
    expect(outputs[1]).toContain('invalid_arguments');
    expect(outputs[2]).toContain('invalid_arguments');
    expect(
      await LedgerEntryModel.exists({
        idempotencyKey: { $regex: `^callusage:${s.io.callId}:emb:` },
      }),
    ).toBeTruthy();
    s.stop();
    await s.done;
  });

  it(`more than ${String(CALL_LIMITS.functionCallsPerTurn)} tool calls in one reply are refused`, async () => {
    const s = start();
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    s.receive([
      ...Array.from({ length: CALL_LIMITS.functionCallsPerTurn + 1 }, (_, i) => ({
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: `c${String(i)}`,
        name: 'nope',
        arguments: '{}',
      })),
      { type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } },
    ]);
    await s.until(() => said(s).some((e) => e.type === 'response.create'));
    const outputs = said(s)
      .filter((e) => (e.item as { type?: string } | undefined)?.type === 'function_call_output')
      .map((e) => (e.item as { output: string }).output);
    expect(outputs).toHaveLength(CALL_LIMITS.functionCallsPerTurn + 1);
    expect(outputs.at(-1)).toContain('too_many_tool_calls');
    expect(outputs[0]).toContain('unknown_tool');
    s.stop();
    await s.done;
  });

  it('end_call ends the step after the closing reply; English words switch the silence prompt; silence → no_response', async () => {
    const s = start();
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    customer(s, 'ok bye now please');
    s.receive([
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 'e1',
        name: 'end_call',
        arguments: '{}',
      },
      { type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } },
    ]);
    await s.until(() => said(s).some((e) => e.type === 'response.create'));
    reply(s, 'Goodbye.');
    await s.until(() => s.result() !== null);
    expect(s.result()?.reason).toBe('end_call');

    const quiet = start();
    await quiet.until(() => said(quiet).some((e) => e.type === 'session.update'));
    customer(quiet, 'hello there friend');
    reply(quiet, 'Hello!');
    await quiet.until(() => JSON.stringify(said(quiet)).includes(CALL_LINES.silenceEn));
    reply(quiet, CALL_LINES.silenceEn); // the model says the prompt
    await quiet.until(() => quiet.result() !== null, 60_000);
    expect(quiet.result()?.reason).toBe('no_response');
    const prompt = said(quiet).find(
      (e) => e.type === 'response.create' && JSON.stringify(e).includes(CALL_LINES.silenceEn),
    );
    expect(prompt).toBeTruthy();
    expect(quiet.metrics.silencePrompts).toBe(1);
  });

  it('a fatal provider error speaks the AI-failed line and ends the step as fallback', async () => {
    const s = start();
    await s.until(() => said(s).some((e) => e.type === 'session.update'));
    s.receive([{ type: 'error', error: { type: 'server_error', message: 'x' } }]);
    expect(s.events.some((e) => e.type === 'error')).toBe(true);
    expect(s.result()).toBeNull(); // non-fatal: goes on
    s.socket.emit('close');
    await s.until(() => s.result() !== null);
    expect(s.result()).toMatchObject({ reason: 'fallback', callEnd: 'ai_failed' });
    expect(s.lines.at(-1)).toBe(`bot:${agent.fallback.aiFailed}`);
  });

  it('open failure → AI-failed line; an inactive agent → agent-off line; flow max duration ends the call', async () => {
    const failed = start({}, { failOpen: true });
    await failed.until(() => failed.result() !== null);
    expect(failed.result()?.reason).toBe('fallback');
    expect(failed.lines).toEqual([`bot:${agent.fallback.aiFailed}`]);

    const off = start({ isActive: false });
    await off.until(() => off.result() !== null);
    expect(off.lines).toEqual([`bot:${agent.fallback.agentOff}`]);

    const long = start({
      callBehaviour: {
        ...agent.callBehaviour,
        maxCallDurationSec: 60,
        silenceTimeoutSec: 30,
        endCallAfterSilenceRetries: 3,
      },
    });
    await long.until(() => long.ended.length > 0, 70_000);
    expect(long.ended).toEqual(['max_duration']);
    long.stop();
    await long.done;
  });

  it('agent-only: the opening line is spoken by the model; a transfer goes to the browser', async () => {
    const s = start(
      {
        builtInTools: {
          ...agent.builtInTools,
          transferToHuman: { enabled: true, phone: '+91 98765 43210', message: null },
        },
      },
      { mode: 'agent' },
    );
    await s.until(() => said(s).some((e) => e.type === 'response.create'));
    expect(JSON.stringify(said(s).find((e) => e.type === 'response.create'))).toContain(
      'Namaste Asha ji.',
    );
    reply(s, 'Namaste Asha ji.');
    customer(s, 'insaan se baat karao');
    s.receive([
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 't1',
        name: 'transfer_to_human',
        arguments: '{"reason":"asked"}',
      },
      { type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } },
    ]);
    await s.until(() => said(s).filter((e) => e.type === 'response.create').length >= 2);
    reply(s, 'Jod rahi hoon.');
    await s.until(() => s.events.some((e) => e.type === 'transfer'));
    expect(s.events.find((e) => e.type === 'transfer')?.data).toEqual({ phoneLast4: '3210' });
    s.leg.receiveControl({ type: 'call.transfer_result', result: 'no_answer' });
    await talk(s.clock, s.leg, 200);
    expect(s.result()).toBeNull(); // no answer: the conversation goes on
    customer(s, 'phir se try karo, insaan chahiye');
    s.receive([
      {
        type: 'response.function_call_arguments.done',
        response_id: 'r',
        item_id: 'f',
        call_id: 't2',
        name: 'end_call',
        arguments: '{}',
      },
      { type: 'response.done', response: { id: 'r', status: 'completed', usage: {} } },
    ]);
    await s.until(() => said(s).filter((e) => e.type === 'response.create').length >= 3);
    reply(s, 'Dhanyavaad.');
    await s.until(() => s.result() !== null);
    expect(s.result()).toMatchObject({ reason: 'end_call', callEnd: 'agent_end_call' });
  });
});

describe('languageOf', () => {
  it('Devanagari and Roman Hindi → hi; plain English → en', () => {
    expect(languageOf('मैंने भुगतान कर दिया')).toBe('hi');
    expect(languageOf('maine payment kar diya')).toBe('hi');
    expect(languageOf('I already paid')).toBe('en');
  });
});
