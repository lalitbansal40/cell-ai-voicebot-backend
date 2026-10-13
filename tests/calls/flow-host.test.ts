import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/core/voice/clock';
import {
  FlowHost,
  type AiStepEnd,
  type AiStepRequest,
  type FlowHostDeps,
} from '../../src/core/voice/flow-host';
import { FakeStt } from '../../src/core/voice/providers';
import type { CallIO } from '../../src/modules/calls/session';
import { answer, makeLeg, pumpUntil, talk } from '../helpers/calls';
import {
  buildGraph,
  fakeEffects,
  testContext,
  type RawEdge,
  type RawNode,
} from '../helpers/engine';

const START: RawNode = { id: 'start', type: 'start' };
const BYE: RawNode = { id: 'bye', type: 'hangup', config: { text: 'Bye' } };
const LINE_MS = 600;

/** A call IO over a real web leg: every line plays 600 ms of silence. */
const fakeIo = (clock: FakeClock) => {
  const { leg, json } = makeLeg(clock);
  answer(leg);
  const said: string[] = [];
  const heard: string[] = [];
  const events: string[] = [];
  const cut: string[] = [];
  const io = {
    callId: 'c1',
    accountId: 'a1',
    leg,
    clock,
    ended: false,
    say: async (text: string) => {
      said.push(text);
      const r = await leg.play(new Int16Array(24 * LINE_MS));
      if (!r.completed) cut.push(text);
      return r;
    },
    play: async (_pcm: Int16Array, text: string | null) => {
      said.push(`♪${text ?? ''}`);
      return leg.play(new Int16Array(24 * LINE_MS));
    },
    interrupt: () => leg.clearAudio(),
    transcript: (speaker: string, text: string) => heard.push(`${speaker}:${text}`),
    partial: () => undefined,
    event: (type: string, data: Record<string, unknown> = {}) =>
      events.push(`${type}${'nodeId' in data ? `:${String(data.nodeId)}` : ''}`),
    customerDone: () => undefined,
    end: () => undefined,
    elapsedMs: () => clock.now(),
  } as unknown as CallIO;
  return { io, leg, json, said, heard, events, cut };
};

type HostOptions = {
  runAi?: (request: AiStepRequest) => Promise<AiStepEnd>;
  loadAudio?: (id: string) => Promise<Int16Array | null>;
  language?: string;
};

const host = (nodes: RawNode[], edges: RawEdge[], options: HostOptions = {}) => {
  const clock = new FakeClock();
  const graph = buildGraph(nodes, edges);
  const finished: string[] = [];
  const steps: number[] = [];
  const deps: FlowHostDeps = {
    graph,
    ctx: testContext(undefined, 'call').ctx,
    effects: fakeEffects(),
    contact: {},
    seed: {},
    stt: new FakeStt(),
    language: options.language ?? 'hinglish',
    voice: 'alloy',
    loadAudio: options.loadAudio ?? (() => Promise.resolve(null)),
    runAi:
      options.runAi ??
      (() =>
        Promise.resolve({
          outcome: {},
          reason: 'outcome',
          turns: 1,
          aiSeconds: 1,
          language: null,
        })),
    onStep: (r) => {
      steps.push(r.trace.length);
      return Promise.resolve();
    },
    onFinish: (state) => {
      finished.push(state.endReason ?? '');
      return Promise.resolve('run1');
    },
  };
  const h = new FlowHost(deps);
  const io = fakeIo(clock);
  let reason: unknown = 'running';
  const done = h.run(io.io).then((r) => (reason = r));
  const until = (check: () => boolean, ms = 30_000) =>
    pumpUntil(clock, io.leg, () => Promise.resolve(check()), ms);
  const press = (keys: string) => {
    for (const digit of keys) io.leg.receiveControl({ type: 'call.dtmf', digit });
  };
  return { h, deps, clock, ...io, finished, steps, done, until, press, reason: () => reason };
};

const digitsFlow = (config: Record<string, unknown> = {}): [RawNode[], RawEdge[]] => [
  [
    START,
    {
      id: 'pin',
      type: 'gather_dtmf',
      config: {
        prompt: { kind: 'speak', text: 'Enter your PIN' },
        mode: 'digits',
        minDigits: 1,
        maxDigits: 4,
        saveAs: 'pin',
        maxRetries: 0,
        timeoutSec: 5,
        ...config,
      },
    },
    BYE,
    { id: 'fail', type: 'hangup', config: { text: 'Fail' } },
  ],
  [
    ['start', 'next', 'pin'],
    ['pin', 'next', 'bye'],
    ['pin', 'no_input', 'fail'],
    ['pin', 'invalid', 'fail'],
  ],
];

describe('FlowHost — keypad digits', () => {
  it('max digits end the gather', async () => {
    const t = host(...digitsFlow());
    await t.until(() => t.said.includes('Enter your PIN') && !t.leg.playing);
    t.press('1234');
    await t.until(() => t.reason() !== 'running');
    expect(t.h.result().variables.pin).toBe('1234');
    expect(t.reason()).toBe('hangup_node');
    expect(t.finished).toEqual(['hangup_node']);
    expect(t.h.result().flowRunId).toBe('run1');
  });

  it('the # key ends it, also when typed while the prompt plays (type-ahead)', async () => {
    const t = host(...digitsFlow());
    await t.until(() => t.leg.playing);
    t.press('12#');
    await t.until(() => t.reason() !== 'running');
    expect(t.h.result().variables.pin).toBe('12');
  });

  it('a 3 s pause after some keys ends it', async () => {
    const t = host(...digitsFlow());
    await t.until(() => t.said.includes('Enter your PIN') && !t.leg.playing);
    t.press('98');
    await t.until(() => t.reason() !== 'running');
    expect(t.h.result().variables.pin).toBe('98');
    expect(t.said.at(-1)).toBe('Bye');
  });

  it('regression: keys typed when the gather times out still count', async () => {
    const t = host(...digitsFlow());
    await t.until(() => t.said.includes('Enter your PIN') && !t.leg.playing);
    await talk(t.clock, t.leg, 4500);
    t.press('7');
    await talk(t.clock, t.leg, 600); // the 5 s timeout fires before the 3 s pause
    await t.until(() => t.reason() !== 'running');
    expect(t.h.result().variables.pin).toBe('7');
    expect(t.said.at(-1)).toBe('Bye');
  });

  it('no keys at all → no input', async () => {
    const t = host(...digitsFlow());
    await t.until(() => t.reason() !== 'running');
    expect(t.said.at(-1)).toBe('Fail');
  });
});

describe('FlowHost — speech, wait, transfer, audio', () => {
  const speechFlow: [RawNode[], RawEdge[]] = [
    [
      START,
      {
        id: 'ask',
        type: 'gather_speech',
        config: {
          prompt: { kind: 'speak', text: 'How can I help?' },
          intents: [{ id: 'pay', label: 'Paid', keywords: ['paid'] }],
          maxRetries: 0,
          timeoutSec: 5,
        },
      },
      { id: 'paid', type: 'hangup', config: { text: 'Thanks', disposition: 'paid' } },
      { id: 'other', type: 'hangup', config: { text: 'Other' } },
    ],
    [
      ['start', 'next', 'ask'],
      ['ask', 'intent_pay', 'paid'],
      ['ask', 'no_match', 'other'],
      ['ask', 'no_input', 'other'],
    ],
  ];

  it('typed words reach the gather; talking restarts the no-input timer; silence → no input', async () => {
    const typed = host(...speechFlow);
    await typed.until(() => typed.said.includes('How can I help?') && !typed.leg.playing);
    typed.leg.receiveControl({ type: 'call.say_text', text: 'I have paid already' });
    await typed.until(() => typed.reason() !== 'running');
    expect(typed.heard).toContain('customer:I have paid already');
    expect(typed.h.result().disposition).toBe('paid');

    const talking = host(...speechFlow);
    await talking.until(() => talking.said.includes('How can I help?') && !talking.leg.playing);
    await talk(talking.clock, talking.leg, 4000);
    await talk(talking.clock, talking.leg, 400, 8000); // loud: speech started → full time again
    await talk(talking.clock, talking.leg, 3000);
    expect(talking.reason()).toBe('running');
    await talking.until(() => talking.reason() !== 'running');
    expect(talking.said.at(-1)).toBe('Other');
  });

  it('typed words while the prompt plays cut it (barge-in) and still count', async () => {
    const t = host(...speechFlow);
    await t.until(() => t.leg.playing);
    t.leg.receiveControl({ type: 'call.say_text', text: 'paid' });
    await t.until(() => t.reason() !== 'running');
    expect(t.cut).toEqual(['How can I help?']);
    expect(t.said.at(-1)).toBe('Thanks');
  });

  it('a wait step waits on the clock; a transfer goes to the browser and back', async () => {
    const wait = host(
      [START, { id: 'w', type: 'wait', config: { seconds: 3 } }, BYE],
      [
        ['start', 'next', 'w'],
        ['w', 'next', 'bye'],
      ],
    );
    await talk(wait.clock, wait.leg, 2000);
    expect(wait.said).toEqual([]);
    await wait.until(() => wait.reason() !== 'running');
    expect(wait.said).toEqual(['Bye']);

    const transferFlow = (): [RawNode[], RawEdge[]] => [
      [
        START,
        { id: 'tx', type: 'transfer_to_agent', config: { phone: '+919876543210' } },
        { id: 'na', type: 'hangup', config: { text: 'Nobody answered' } },
      ],
      [
        ['start', 'next', 'tx'],
        ['tx', 'no_answer', 'na'],
        ['tx', 'failed', 'na'],
      ],
    ];
    const missed = host(...transferFlow());
    await missed.until(() => missed.json.some((m) => m.type === 'call.transfer'));
    expect(missed.json.find((m) => m.type === 'call.transfer')).toEqual({
      type: 'call.transfer',
      phoneLast4: '3210',
    });
    expect(missed.events).toContain('transfer');
    missed.leg.receiveControl({ type: 'call.transfer_result', result: 'no_answer' });
    await missed.until(() => missed.reason() !== 'running');
    expect(missed.said.at(-1)).toBe('Nobody answered');

    const connected = host(...transferFlow());
    await connected.until(() => connected.json.some((m) => m.type === 'call.transfer'));
    connected.leg.receiveControl({ type: 'call.transfer_result', result: 'connected' });
    await connected.until(() => connected.reason() !== 'running');
    expect(connected.reason()).toBe('transferred');
  });

  it('plays library audio; a missing file plays nothing', async () => {
    const flow = (): [RawNode[], RawEdge[]] => [
      [
        START,
        { id: 'p', type: 'play_audio', config: { audioId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
        BYE,
      ],
      [
        ['start', 'next', 'p'],
        ['p', 'next', 'bye'],
      ],
    ];
    const ok = host(...flow(), { loadAudio: () => Promise.resolve(new Int16Array(2400)) });
    await ok.until(() => ok.reason() !== 'running');
    expect(ok.said).toEqual(['♪Welcome', 'Bye']);
    const missing = host(...flow());
    await missing.until(() => missing.reason() !== 'running');
    expect(missing.said).toEqual(['Bye']);
  });
});

describe('FlowHost — the AI step and stopping', () => {
  const aiFlow: [RawNode[], RawEdge[]] = [
    [
      START,
      { id: 'ai', type: 'ai_agent', config: { agentId: 'bbbbbbbbbbbbbbbbbbbbbbbb' } },
      { id: 'promise', type: 'hangup', config: { text: 'Promise saved' } },
      { id: 'done', type: 'hangup', config: { text: 'Done' } },
      { id: 'quiet', type: 'hangup', config: { text: 'Quiet' } },
      { id: 'err', type: 'hangup', config: { text: 'Error' } },
    ],
    [
      ['start', 'next', 'ai'],
      ['ai', 'promise_to_pay', 'promise'],
      ['ai', 'resolved', 'done'],
      ['ai', 'no_response', 'quiet'],
      ['ai', 'error', 'err'],
    ],
  ];

  it('hands audio and text to the live session, then routes on its outcome', async () => {
    const frames: number[] = [];
    const texts: string[] = [];
    let release: (end: AiStepEnd) => void = () => undefined;
    const t = host(...aiFlow, {
      runAi: (request) => {
        expect(request.nodeId).toBe('ai');
        expect(request.turns[0]).toMatchObject({ role: 'assistant' });
        request.inputs.setAudio((f) => frames.push(f.length));
        request.inputs.setText((x) => texts.push(x));
        return new Promise((resolve) => (release = resolve));
      },
    });
    await t.until(() => t.events.includes('ai_session_started:ai'));
    expect(t.said[0]).toBe('Namaste, main AI assistant hoon.'); // the opening line
    t.leg.receiveControl({ type: 'call.say_text', text: 'kal de dunga' });
    await talk(t.clock, t.leg, 100);
    expect(texts).toEqual(['kal de dunga']);
    expect(frames.length).toBeGreaterThan(0);
    release({
      outcome: { promiseToPay: { date: '2026-10-14', amountMicros: null } },
      reason: 'outcome',
      turns: 3,
      aiSeconds: 40,
      language: 'hi',
    });
    await t.until(() => t.reason() !== 'running');
    expect(t.said.at(-1)).toBe('Promise saved');
    expect(t.events).toContain('ai_session_ended:ai');
    expect(t.h.result()).toMatchObject({ aiSeconds: 40, languageDetected: 'hi' });
    // back to the flow: audio goes to STT again
    const before = frames.length;
    await talk(t.clock, t.leg, 100);
    expect(frames.length).toBe(before);
  });

  it.each([
    ['no_response', 'Quiet'],
    ['max_turns', 'Quiet'],
    ['end_call', 'Done'],
    ['fallback', 'Error'],
  ] as const)('a session that ends with %s goes to %s', async (reason, line) => {
    const t = host(...aiFlow, {
      runAi: () => Promise.resolve({ outcome: {}, reason, turns: 2, aiSeconds: 5, language: null }),
    });
    await t.until(() => t.reason() !== 'running');
    expect(t.said.at(-1)).toBe(line);
  });

  it('stop() while waiting ends the run as customer_hangup; stopping twice / after the end is safe', async () => {
    const t = host(...digitsFlow({ timeoutSec: 20 }));
    await t.until(() => t.said.includes('Enter your PIN') && !t.leg.playing);
    await t.h.stop('customer_hangup');
    await t.h.stop('customer_hangup');
    await t.done;
    expect(t.reason()).toBeUndefined();
    expect(t.finished).toEqual(['customer_hangup']);

    let release: (end: AiStepEnd) => void = () => undefined;
    // a live AI step ends itself when told the call is over (onStop); stop() waits for it
    const ai = host(...aiFlow, {
      runAi: (request) =>
        new Promise((resolve) => {
          release = resolve;
          request.inputs.onStop(() =>
            resolve({ outcome: {}, reason: 'outcome', turns: 1, aiSeconds: 7, language: 'en' }),
          );
        }),
    });
    await ai.until(() => ai.events.includes('ai_session_started:ai'));
    await ai.h.stop('max_duration');
    await ai.done;
    expect(ai.reason()).toBeUndefined();
    expect(ai.finished).toEqual(['max_duration']);
    expect(ai.h.result()).toMatchObject({ aiSeconds: 7, languageDetected: 'en' });
    release({ outcome: {}, reason: 'outcome', turns: 1, aiSeconds: 1, language: null }); // late: ignored

    const ended = host(...digitsFlow());
    await ended.until(() => ended.leg.playing);
    ended.press('1#');
    await ended.until(() => ended.reason() !== 'running');
    await ended.h.stop('customer_hangup');
    expect(ended.finished).toEqual(['hangup_node']);
  });

  it('an empty result before the run starts', () => {
    const t = host(...digitsFlow());
    expect(new FlowHost(t.deps).result()).toEqual({
      outcome: {},
      disposition: null,
      variables: {},
      flowRunId: null,
      aiSeconds: 0,
      languageDetected: null,
    });
  });
});
