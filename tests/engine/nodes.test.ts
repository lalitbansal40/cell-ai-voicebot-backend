import { describe, expect, it } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import { advance, InputMismatchError } from '../../src/core/engine/engine';
import { aiExitOf } from '../../src/core/engine/nodes/ai-agent';
import type { FlowEffects, FlowInputBody, FlowOutput } from '../../src/core/engine/types';
import {
  buildGraph,
  fakeEffects,
  reply,
  testContext,
  type RawEdge,
  type RawNode,
} from '../helpers/engine';

const AUDIO = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const AGENT = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const texts = (outputs: FlowOutput[]) =>
  outputs.flatMap((o) => (o.type === 'say' || o.type === 'ai_reply' ? [o.text] : []));

const play = async (
  nodes: RawNode[],
  edges: RawEdge[],
  inputs: FlowInputBody[] = [],
  effects: FlowEffects = fakeEffects(),
  extra: Record<string, unknown> = {},
) => {
  const graph = buildGraph(
    [{ id: 'start', type: 'start' }, ...nodes],
    [['start', 'next', nodes[0]!.id], ...edges],
    extra,
  );
  const { ctx } = testContext();
  let r = await advance(
    graph,
    null,
    { kind: 'start', trigger: 'test', inputId: 'in0' },
    effects,
    ctx,
    { name: 'Asha' },
  );
  const steps = [r];
  for (const [i, input] of inputs.entries()) {
    r = await advance(graph, r.state, { ...input, inputId: `in${String(i + 1)}` }, effects, ctx);
    steps.push(r);
  }
  return { last: r, steps, all: steps.flatMap((s) => s.outputs) };
};

const bye = (id = 'bye', text?: string): RawNode => ({
  id,
  type: 'hangup',
  config: text ? { text } : {},
});

describe('speak / play_audio', () => {
  it('speak renders variables, language and interruptible', async () => {
    const { all } = await play(
      [
        {
          id: 's',
          type: 'speak',
          config: { text: 'Hi {{name}} {{missing}}', language: 'en', interruptible: false },
        },
        bye(),
      ],
      [['s', 'next', 'bye']],
    );
    expect(all[0]).toEqual({
      type: 'say',
      nodeId: 's',
      text: 'Hi Asha ',
      language: 'en',
      voice: 'coral',
      interruptible: false,
    });
  });

  it('play_audio: file → play; missing → fallback text; missing without fallback → error', async () => {
    expect(
      (
        await play(
          [{ id: 'p', type: 'play_audio', config: { audioId: AUDIO } }, bye()],
          [['p', 'next', 'bye']],
        )
      ).all[0],
    ).toEqual({
      type: 'play',
      nodeId: 'p',
      audioId: AUDIO,
      audioName: 'Welcome',
    });
    const gone = 'cccccccccccccccccccccccc';
    const fallback = await play(
      [{ id: 'p', type: 'play_audio', config: { audioId: gone, fallbackText: 'Hello' } }, bye()],
      [['p', 'next', 'bye']],
    );
    expect(texts(fallback.all)).toEqual(['Hello']);
    const failed = await play(
      [{ id: 'p', type: 'play_audio', config: { audioId: gone } }, bye('oops', 'Oops')],
      [['p', 'error', 'oops']],
    );
    expect(texts(failed.all)).toEqual(['Oops']);
  });

  it('gather prompts can be audio (missing audio → fallback / error)', async () => {
    const gather = (prompt: object) => [
      { id: 'g', type: 'gather_dtmf', config: { prompt, keys: [{ id: 'k1', key: '1' }] } },
      bye(),
      bye('oops', 'Oops'),
    ];
    const edges: RawEdge[] = [
      ['g', 'key_k1', 'bye'],
      ['g', 'error', 'oops'],
    ];
    expect((await play(gather({ kind: 'audio', audioId: AUDIO }), edges)).all[0]).toMatchObject({
      type: 'play',
    });
    expect(
      texts(
        (
          await play(
            gather({ kind: 'audio', audioId: 'c'.repeat(24), fallbackText: 'Press 1' }),
            edges,
          )
        ).all,
      ),
    ).toEqual(['Press 1']);
    expect(
      texts((await play(gather({ kind: 'audio', audioId: 'c'.repeat(24) }), edges)).all),
    ).toEqual(['Oops']);
    // the retry prompt fails too → error exit
    const speech = await play(
      [
        { id: 'g', type: 'gather_speech', config: { prompt: { kind: 'audio', audioId: AUDIO } } },
        bye(),
        bye('oops', 'Oops'),
      ],
      [
        ['g', 'next', 'bye'],
        ['g', 'error', 'oops'],
      ],
      [{ kind: 'no_input' }],
      fakeEffects({
        loadAudio: (() => {
          let n = 0;
          return (id: string) => Promise.resolve(n++ === 0 ? { id, name: 'W' } : null);
        })(),
      }),
    );
    expect(texts(speech.last.outputs)).toContain('Oops');
  });
});

describe('gather_speech', () => {
  const nodes = (config: Record<string, unknown> = {}): RawNode[] => [
    {
      id: 'ask',
      type: 'gather_speech',
      config: {
        prompt: { kind: 'speak', text: 'Bataiye?' },
        saveAs: 'said',
        maxRetries: 1,
        ...config,
      },
    },
    bye('next', 'Next'),
    bye('pay', 'Pay'),
    bye('agent', 'Agent'),
    bye('nomatch', 'No match'),
    bye('silent', 'Silent'),
  ];
  const edges: RawEdge[] = [
    ['ask', 'next', 'next'],
    ['ask', 'intent_pay', 'pay'],
    ['ask', 'intent_agent', 'agent'],
    ['ask', 'no_match', 'nomatch'],
    ['ask', 'no_input', 'silent'],
  ];
  const vars = { variables: [{ name: 'said', type: 'text' }] };
  const intents = [
    { id: 'pay', label: 'Pay', keywords: ['pay kar diya'] },
    { id: 'agent', label: 'Agent', keywords: ['insaan'] },
  ];

  it('without intents saves the answer and goes next; waits with a speech listener', async () => {
    const r = await play(
      nodes(),
      edges.slice(0, 1).concat([edges[4]!]),
      [{ kind: 'speech', text: '  Kal karunga ' }],
      fakeEffects(),
      vars,
    );
    expect(r.steps[0]?.waiting).toEqual({ kind: 'speech', nodeId: 'ask', timeoutSec: 8 });
    expect(r.steps[0]?.outputs.at(-1)).toEqual({
      type: 'listen_speech',
      nodeId: 'ask',
      timeoutSec: 8,
      language: 'hinglish',
    });
    expect(texts(r.last.outputs)).toEqual(['Next']);
    expect(r.last.state.variables).toMatchObject({
      said: 'Kal karunga',
      last_speech: 'Kal karunga',
    });
  });

  it('keyword intents pick the exit; no match retries then no_match; empty speech is silence', async () => {
    const cfg = nodes({ intents });
    expect(
      texts(
        (
          await play(
            cfg,
            edges,
            [{ kind: 'speech', text: 'Maine PAY kar diya!' }],
            fakeEffects(),
            vars,
          )
        ).last.outputs,
      ),
    ).toEqual(['Pay']);
    const miss = await play(
      cfg,
      edges,
      [
        { kind: 'speech', text: 'hello' },
        { kind: 'speech', text: 'bye' },
      ],
      fakeEffects(),
      vars,
    );
    expect(texts(miss.steps[1]!.outputs)).toEqual([
      'Maaf kijiye, yeh option sahi nahi hai.',
      'Bataiye?',
    ]);
    expect(texts(miss.last.outputs)).toEqual(['No match']);
    const silent = await play(
      cfg,
      edges,
      [{ kind: 'speech', text: '  ' }, { kind: 'no_input' }],
      fakeEffects(),
      vars,
    );
    expect(texts(silent.last.outputs)).toEqual(['Silent']);
    expect(silent.last.state.variables.last_intent).toBeNull();
  });

  it('AI intents use the classifier, fall back to keywords on failure, ignore unknown ids', async () => {
    const cfg = nodes({ intents, matchMode: 'ai', maxRetries: 0 });
    const ai = fakeEffects({ classifyIntent: () => Promise.resolve('agent') });
    const r = await play(cfg, edges, [{ kind: 'speech', text: 'kuch bhi' }], ai, vars);
    expect(texts(r.last.outputs)).toEqual(['Agent']);
    expect(r.last.state.variables.last_intent).toBe('agent');
    const broken = fakeEffects({ classifyIntent: () => Promise.reject(new Error('down')) });
    const fb = await play(cfg, edges, [{ kind: 'speech', text: 'pay kar diya' }], broken, vars);
    expect(texts(fb.last.outputs)).toEqual(['Pay']);
    expect(fb.last.outputs.some((o) => o.type === 'note')).toBe(true);
    const unknown = fakeEffects({ classifyIntent: () => Promise.resolve('ghost') });
    expect(
      texts((await play(cfg, edges, [{ kind: 'speech', text: 'x' }], unknown, vars)).last.outputs),
    ).toEqual(['No match']);
  });

  it('a value that does not fit the saveAs type is cleared with a note', async () => {
    const r = await play(
      [
        {
          id: 'ask',
          type: 'gather_speech',
          config: { prompt: { kind: 'speak', text: 'Number?' }, saveAs: 'n' },
        },
        bye(),
      ],
      [['ask', 'next', 'bye']],
      [{ kind: 'speech', text: 'pachaas' }],
      fakeEffects(),
      { variables: [{ name: 'n', type: 'number' }] },
    );
    expect(r.last.state.variables.n).toBeNull();
    expect(r.last.outputs.find((o) => o.type === 'note')).toMatchObject({
      text: '"pachaas" is not a valid number for n',
    });
  });
});

describe('logic nodes', () => {
  it('condition router compares typed values in order', async () => {
    const graph = (status: string) =>
      play(
        [
          {
            id: 'set',
            type: 'set_variable',
            config: {
              assignments: [
                { variable: 'status', value: status },
                { variable: 'amount', value: '500' },
              ],
            },
          },
          {
            id: 'r',
            type: 'condition_router',
            config: {
              rules: [
                {
                  id: 'paid',
                  conditions: [{ variable: 'status', operator: 'equals', value: 'paid' }],
                },
                {
                  id: 'big',
                  conditions: [{ variable: 'amount', operator: 'gt', value: '{{limit}}' }],
                },
              ],
            },
          },
          bye('a', 'Paid'),
          bye('b', 'Big'),
          bye('c', 'Else'),
        ],
        [
          ['set', 'next', 'r'],
          ['r', 'rule_paid', 'a'],
          ['r', 'rule_big', 'b'],
          ['r', 'else', 'c'],
        ],
        [],
        fakeEffects(),
        {
          variables: [
            { name: 'status', type: 'text' },
            { name: 'amount', type: 'number' },
            { name: 'limit', type: 'number', default: 100 },
          ],
        },
      );
    expect(texts((await graph('PAID')).all)).toEqual(['Paid']);
    expect(texts((await graph('unpaid')).all)).toEqual(['Big']);
  });

  it('set_variable: set typed, increment, clear; bad values take the error exit', async () => {
    const r = await play(
      [
        {
          id: 'set',
          type: 'set_variable',
          config: {
            assignments: [
              { variable: 'n', op: 'increment', value: '2' },
              { variable: 'n', op: 'increment', value: '3' },
              { variable: 'flag', value: 'haan' },
              { variable: 'note', value: 'Hi {{name}}' },
              { variable: 'note2', op: 'clear' },
            ],
          },
        },
        bye(),
      ],
      [['set', 'next', 'bye']],
      [],
      fakeEffects(),
      {
        variables: [
          { name: 'n', type: 'number' },
          { name: 'flag', type: 'boolean' },
          { name: 'note', type: 'text' },
          { name: 'note2', type: 'text', default: 'x' },
        ],
      },
    );
    expect(r.last.state.variables).toMatchObject({
      n: 5,
      flag: true,
      note: 'Hi Asha',
      note2: null,
    });
    for (const assignment of [
      { variable: 'n', value: 'abc' },
      { variable: 'n', op: 'increment', value: 'x' },
      { variable: 'n', op: 'increment', value: '{{empty}}' },
    ]) {
      const bad = await play(
        [
          { id: 'set', type: 'set_variable', config: { assignments: [assignment] } },
          bye(),
          bye('oops', 'Oops'),
        ],
        [
          ['set', 'next', 'bye'],
          ['set', 'error', 'oops'],
        ],
        [],
        fakeEffects(),
        {
          variables: [
            { name: 'n', type: 'number' },
            { name: 'empty', type: 'text' },
          ],
        },
      );
      expect(texts(bad.all)).toEqual(['Oops']);
    }
  });

  it('set_disposition records the outcome (last wins); hangup sets one only when none', async () => {
    const r = await play(
      [
        { id: 'd1', type: 'set_disposition', config: { disposition: 'callback_requested' } },
        {
          id: 'd2',
          type: 'set_disposition',
          config: { disposition: 'promise_to_pay', note: 'By {{name}}' },
        },
        { id: 'bye', type: 'hangup', config: { disposition: 'other' } },
      ],
      [
        ['d1', 'next', 'd2'],
        ['d2', 'next', 'bye'],
      ],
    );
    expect(r.last.state.outcome).toMatchObject({
      disposition: 'promise_to_pay',
      dispositionNote: 'By Asha',
    });
    expect(r.last.state.variables.disposition).toBe('promise_to_pay');
  });

  it('wait pauses until a timer input', async () => {
    const r = await play(
      [{ id: 'w', type: 'wait', config: { seconds: 5 } }, bye('bye', 'Done')],
      [['w', 'next', 'bye']],
      [{ kind: 'timer' }],
    );
    expect(r.steps[0]?.waiting).toEqual({ kind: 'timer', nodeId: 'w', seconds: 5 });
    expect(r.steps[0]?.outputs).toEqual([{ type: 'pause', nodeId: 'w', seconds: 5 }]);
    expect(texts(r.last.outputs)).toEqual(['Done']);
  });
});

describe('actions', () => {
  it('transfer: announcement + transfer action; connected ends; failed / no_answer exits', async () => {
    const nodes: RawNode[] = [
      {
        id: 't',
        type: 'transfer_to_agent',
        config: { phone: '{{agent_phone}}', announcement: 'Jod rahi hoon', timeoutSec: 20 },
      },
      bye('failed', 'Failed'),
      bye('na', 'No answer'),
    ];
    const edges: RawEdge[] = [
      ['t', 'failed', 'failed'],
      ['t', 'no_answer', 'na'],
    ];
    const vars = { variables: [{ name: 'agent_phone', type: 'text', default: '+919876543210' }] };
    const first = await play(nodes, edges, [], fakeEffects(), vars);
    expect(first.all).toEqual([
      expect.objectContaining({ type: 'say', text: 'Jod rahi hoon' }),
      { type: 'transfer', nodeId: 't', phone: '+919876543210', timeoutSec: 20 },
    ]);
    expect(first.last.waiting).toMatchObject({ kind: 'transfer', transferPhoneLast4: '3210' });
    const ok = await play(
      nodes,
      edges,
      [{ kind: 'transfer_result', result: 'connected' }],
      fakeEffects(),
      vars,
    );
    expect(ok.last.state).toMatchObject({
      endReason: 'transferred',
      outcome: { transfer: { result: 'connected' } },
    });
    expect(ok.last.outputs).toEqual([]);
    expect(
      texts(
        (
          await play(
            nodes,
            edges,
            [{ kind: 'transfer_result', result: 'no_answer' }],
            fakeEffects(),
            vars,
          )
        ).last.outputs,
      ),
    ).toEqual(['No answer']);
    const bad = await play(
      [{ id: 't', type: 'transfer_to_agent', config: { phone: '12345' } }, bye('oops', 'Oops')],
      [['t', 'error', 'oops']],
    );
    expect(texts(bad.all)).toEqual(['Oops']);
  });

  it('SMS / WhatsApp are queued post-call (≤ 10 per run)', async () => {
    const r = await play(
      [
        {
          id: 'sms',
          type: 'send_sms',
          config: { text: 'Link for {{name}}', dltTemplateId: 'DLT1' },
        },
        {
          id: 'wa',
          type: 'send_whatsapp',
          config: { templateName: 'pay_link', params: ['{{name}}'] },
        },
        bye(),
      ],
      [
        ['sms', 'next', 'wa'],
        ['wa', 'next', 'bye'],
      ],
    );
    expect(r.all.filter((o) => o.type === 'message_queued')).toEqual([
      { type: 'message_queued', nodeId: 'sms', channel: 'sms', preview: 'Link for Asha' },
      { type: 'message_queued', nodeId: 'wa', channel: 'whatsapp', preview: 'pay_link(Asha)' },
    ]);
    expect(r.last.state.outcome.messages).toEqual([
      expect.objectContaining({ channel: 'sms', text: 'Link for Asha', dltTemplateId: 'DLT1' }),
      expect.objectContaining({
        channel: 'whatsapp',
        templateName: 'pay_link',
        params: ['Asha'],
        language: 'hi',
      }),
    ]);
    // cap
    const loop = await play(
      [
        {
          id: 'menu',
          type: 'gather_dtmf',
          config: { prompt: { kind: 'speak', text: 'x' }, keys: [{ id: 'k1', key: '1' }] },
        },
        { id: 'sms', type: 'send_sms', config: { text: 'x' } },
      ],
      [
        ['menu', 'key_k1', 'sms'],
        ['sms', 'next', 'menu'],
      ],
      Array.from({ length: FLOW_LIMITS.messagesPerRunMax + 1 }, () => ({
        kind: 'dtmf' as const,
        digits: '1',
      })),
    );
    expect(loop.last.state.outcome.messages).toHaveLength(FLOW_LIMITS.messagesPerRunMax);
    expect(loop.last.outputs.some((o) => o.type === 'note')).toBe(true);
  });
});

describe('api_request', () => {
  const nodes: RawNode[] = [
    {
      id: 'api',
      type: 'api_request',
      config: {
        url: 'https://x/{{name}}',
        saveResponse: [
          { path: 'status', variable: 'status' },
          { path: 'data.amount', variable: 'amount' },
          { path: 'nope', variable: 'gone' },
          { path: 'data', variable: 'blob' },
        ],
      },
    },
    bye('ok', 'Ok {{status}} {{amount}}'),
    bye('fail', 'Fail {{last_api_status}}'),
    bye('err', 'Err'),
  ];
  const edges: RawEdge[] = [
    ['api', 'success', 'ok'],
    ['api', 'failure', 'fail'],
    ['api', 'error', 'err'],
  ];
  const vars = {
    variables: [
      { name: 'status', type: 'text' },
      { name: 'amount', type: 'number' },
      { name: 'gone', type: 'text', default: 'x' },
      { name: 'blob', type: 'text' },
    ],
  };

  it('2xx saves typed fields (missing ones cleared with a note) and takes success', async () => {
    let seen: Record<string, string> = {};
    const effects = fakeEffects({
      callApi: ({ values }) => {
        seen = values;
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { status: 'paid', data: { amount: '2500' } },
          durationMs: 3,
        });
      },
    });
    const r = await play(nodes, edges, [], effects, vars);
    expect(seen.name).toBe('Asha');
    expect(texts(r.all)).toEqual(['Ok paid 2,500']);
    expect(r.last.state.variables).toMatchObject({
      status: 'paid',
      amount: 2500,
      gone: null,
      blob: '{"amount":"2500"}',
      last_api_status: 200,
    });
  });

  it('non-2xx → failure, no answer → error', async () => {
    const failing = fakeEffects({
      callApi: () => Promise.resolve({ ok: true, status: 404, body: null, durationMs: 1 }),
    });
    expect(texts((await play(nodes, edges, [], failing, vars)).all)).toEqual(['Fail 404']);
    const down = fakeEffects({
      callApi: () => Promise.resolve({ ok: false, error: 'timeout', durationMs: 6000 }),
    });
    expect(texts((await play(nodes, edges, [], down, vars)).all)).toEqual(['Err']);
    // failure without an edge falls back to the error edge
    const fallback = await play(nodes, [edges[0]!, edges[2]!], [], failing, vars);
    expect(texts(fallback.all)).toEqual(['Err']);
  });
});

describe('ai_agent', () => {
  const nodes = (config: Record<string, unknown> = {}): RawNode[] => [
    { id: 'ai', type: 'ai_agent', config: { agentId: AGENT, maxTurns: 3, ...config } },
    bye('resolved', 'Resolved'),
    bye('promise', 'Promise {{promise_date}}'),
    bye('transfer', 'Transfer'),
    bye('noresp', 'No response'),
    bye('err', 'AI error'),
  ];
  const edges: RawEdge[] = [
    ['ai', 'resolved', 'resolved'],
    ['ai', 'promise_to_pay', 'promise'],
    ['ai', 'transfer', 'transfer'],
    ['ai', 'no_response', 'noresp'],
    ['ai', 'error', 'err'],
  ];

  it('says the opening line and waits for the customer', async () => {
    const r = await play(nodes(), edges);
    expect(texts(r.all)).toEqual(['Namaste, main AI assistant hoon.']);
    expect(r.last.waiting).toEqual({ kind: 'ai', nodeId: 'ai' });
    expect(r.last.state.ai).toMatchObject({
      agentId: AGENT,
      turnCount: 0,
      turns: [{ role: 'assistant' }],
    });
    const quiet = await play(nodes({ speakOpeningLine: false }), edges);
    expect(texts(quiet.all)).toEqual([]);
  });

  it('a promise ends the node through promise_to_pay with the outcome saved', async () => {
    const effects = fakeEffects({
      aiTurn: () =>
        Promise.resolve(
          reply('Theek hai', {
            outcome: {
              promiseToPay: { date: '2026-10-11', amountMicros: null },
              smsTemplate: 'pay_link',
            },
          }),
        ),
    });
    const r = await play(nodes(), edges, [{ kind: 'speech', text: 'kal tak de dunga' }], effects);
    expect(texts(r.last.outputs)).toEqual(['Theek hai', 'Promise 11 Oct 2026']);
    expect(r.last.outputs[0]).toMatchObject({ type: 'ai_reply', costMicros: 1000 });
    expect(r.last.state.outcome).toMatchObject({
      disposition: 'promise_to_pay',
      promiseToPay: { date: '2026-10-11' },
    });
    expect(r.last.state.outcome.messages).toEqual([
      expect.objectContaining({ templateName: 'pay_link' }),
    ]);
    expect(r.last.state.ai).toBeNull();
  });

  it('keeps talking until an outcome; max turns → no_response; unconnected outcome → resolved', async () => {
    const chat = await play(nodes(), edges, [
      { kind: 'speech', text: 'a' },
      { kind: 'speech', text: 'b' },
      { kind: 'speech', text: 'c' },
    ]);
    expect(texts(chat.steps[1]!.outputs)).toEqual(['You said: a']);
    expect(chat.steps[1]?.waiting).toEqual({ kind: 'ai', nodeId: 'ai' });
    expect(texts(chat.last.outputs)).toEqual(['You said: c', 'No response']);
    const callback = fakeEffects({
      aiTurn: () =>
        Promise.resolve(
          reply('Ok', { outcome: { callback: { date: '2026-10-12', time: '10:00' } } }),
        ),
    });
    const cb = await play(nodes(), edges, [{ kind: 'speech', text: 'kal call karo' }], callback);
    expect(texts(cb.last.outputs)).toEqual(['Ok', 'Resolved']);
    expect(cb.last.state.variables).toMatchObject({
      callback_date: '2026-10-12',
      callback_time: '10:00',
    });
  });

  it('two silent turns → no_response (one silence asks again)', async () => {
    const r = await play(nodes(), edges, [{ kind: 'no_input' }, { kind: 'speech', text: ' ' }]);
    expect(texts(r.steps[1]!.outputs)).toEqual(['Maaf kijiye, mujhe aapka jawab nahi mila.']);
    expect(texts(r.last.outputs)).toEqual(['No response']);
  });

  it('fallbacks and an unavailable agent take the error exit (fallback text said)', async () => {
    const off = fakeEffects({
      aiStart: () => Promise.resolve({ ok: false, text: 'Agent off line', reason: 'agentOff' }),
    });
    expect(texts((await play(nodes(), edges, [], off)).all)).toEqual([
      'Agent off line',
      'AI error',
    ]);
    const missing = fakeEffects({
      aiStart: () => Promise.resolve({ ok: false, text: null, reason: 'agent_missing' }),
    });
    expect(texts((await play(nodes(), edges, [], missing)).all)).toEqual(['AI error']);
    const wallet = fakeEffects({
      aiTurn: () =>
        Promise.resolve(reply('Wallet empty line', { fallback: 'walletEmpty', costMicros: 0 })),
    });
    expect(
      texts((await play(nodes(), edges, [{ kind: 'speech', text: 'hi' }], wallet)).last.outputs),
    ).toEqual(['Wallet empty line', 'AI error']);
  });

  it('a live voice session ends the step with ai_session_end (calls)', async () => {
    const end = (
      reason: 'outcome' | 'end_call' | 'no_response' | 'max_turns' | 'fallback',
      outcome = {},
    ) => ({ kind: 'ai_session_end', reason, outcome, turns: 2 }) as const;
    const promise = await play(nodes(), edges, [
      end('outcome', { promiseToPay: { date: '2026-10-11', amountMicros: null } }),
    ]);
    expect(texts(promise.last.outputs)).toEqual(['Promise 11 Oct 2026']);
    expect(promise.last.state.outcome.disposition).toBe('promise_to_pay');
    expect(promise.last.state.ai).toBeNull();
    const ended = await play(nodes(), edges, [end('end_call')]);
    expect(texts(ended.last.outputs)).toEqual(['Resolved']);
    const transfer = await play(nodes(), edges, [end('outcome', { transferRequested: true })]);
    expect(texts(transfer.last.outputs)).toEqual(['Transfer']);
    const plain = await play(nodes(), edges, [end('outcome')]);
    expect(texts(plain.last.outputs)).toEqual(['Resolved']);
    for (const reason of ['no_response', 'max_turns'] as const) {
      expect(texts((await play(nodes(), edges, [end(reason)])).last.outputs)).toEqual([
        'No response',
      ]);
    }
    expect(texts((await play(nodes(), edges, [end('fallback')])).last.outputs)).toEqual([
      'AI error',
    ]);
  });

  it('ai_session_end is refused when the run is not waiting for the AI', async () => {
    const graph = [
      {
        id: 'menu',
        type: 'gather_dtmf',
        config: {
          prompt: { kind: 'speak', text: 'Press' },
          keys: [{ id: 'k1', key: '1', label: 'x' }],
        },
      },
      bye('b', 'Bye'),
    ];
    await expect(
      play(
        graph,
        [['menu', 'key_k1', 'b']],
        [{ kind: 'ai_session_end', reason: 'outcome', outcome: {}, turns: 0 }],
      ),
    ).rejects.toThrow(InputMismatchError);
  });

  it('maps outcomes to exits in order', () => {
    const o = (outcome: object, ended = false) => aiExitOf({ outcome, ended });
    expect(o({ transferRequested: true, disposition: 'paid' })).toBe('transfer');
    expect(o({ disposition: 'paid', promiseToPay: { date: 'x', amountMicros: null } })).toBe(
      'paid',
    );
    expect(o({ promiseToPay: { date: 'x', amountMicros: 1 } })).toBe('promise_to_pay');
    expect(o({ callback: { date: 'x', time: null } })).toBe('callback');
    expect(o({ disposition: 'wrong_number' })).toBe('wrong_number');
    expect(o({ endRequested: true })).toBe('resolved');
    expect(o({ disposition: 'refused_to_pay' }, true)).toBe('resolved');
    expect(o({ disposition: 'refused_to_pay' })).toBeNull();
  });

  it('paid / wrong_number dispositions set the run outcome', async () => {
    const paid = fakeEffects({
      aiTurn: () => Promise.resolve(reply('Thanks', { outcome: { disposition: 'paid' } })),
    });
    const r = await play(nodes(), edges, [{ kind: 'speech', text: 'paid' }], paid);
    expect(r.last.state.outcome.disposition).toBe('paid');
    expect(texts(r.last.outputs)).toEqual(['Thanks', 'Resolved']); // paid not connected → resolved
  });
});
