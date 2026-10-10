import { describe, expect, it } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import {
  InputMismatchError,
  RunEndedError,
  advance,
  initialState,
} from '../../src/core/engine/engine';
import { DEFAULT_ERROR_MESSAGE } from '../../src/core/engine/schema';
import type { FlowEffects, FlowInputBody, FlowOutput } from '../../src/core/engine/types';
import {
  buildGraph,
  fakeEffects,
  fixedClock,
  testContext,
  type RawEdge,
  type RawNode,
} from '../helpers/engine';

type Graph = ReturnType<typeof buildGraph>;

const texts = (outputs: FlowOutput[]) =>
  outputs.flatMap((o) => (o.type === 'say' || o.type === 'ai_reply' ? [o.text] : []));

/** Starts a run and feeds inputs; returns every step's result. */
const play = async (
  graph: Graph,
  inputs: FlowInputBody[],
  effects: FlowEffects = fakeEffects(),
  setup = testContext(),
  contact: Record<string, string> = { name: 'Asha', phone_last4: '0001' },
) => {
  let r = await advance(
    graph,
    null,
    { kind: 'start', trigger: 'test', inputId: 'in0' },
    effects,
    setup.ctx,
    contact,
  );
  const steps = [r];
  for (const [i, input] of inputs.entries()) {
    r = await advance(
      graph,
      r.state,
      { ...input, inputId: `in${String(i + 1)}` },
      effects,
      setup.ctx,
    );
    steps.push(r);
  }
  return { steps, last: r, all: steps.flatMap((s) => s.outputs) };
};

const menuNodes = (extra: Record<string, unknown> = {}): RawNode[] => [
  { id: 'start', type: 'start' },
  { id: 'greet', type: 'speak', config: { text: 'Namaste {{name}}' } },
  {
    id: 'menu',
    type: 'gather_dtmf',
    config: {
      prompt: { kind: 'speak', text: '1 ya 2 dabaiye' },
      keys: [
        { id: 'k1', key: '1', label: 'One' },
        { id: 'k2', key: '2', label: 'Two' },
      ],
      repeatKey: '9',
      maxRetries: 2,
      saveAs: 'choice',
      ...extra,
    },
  },
  { id: 'one', type: 'hangup', config: { text: 'Bye one', disposition: 'paid' } },
  { id: 'two', type: 'hangup', config: { text: 'Bye two' } },
  {
    id: 'lost',
    type: 'hangup',
    config: { text: 'No answer bye', disposition: 'callback_requested' },
  },
  { id: 'wrong', type: 'hangup', config: { text: 'Invalid bye' } },
];
const menuEdges: RawEdge[] = [
  ['start', 'next', 'greet'],
  ['greet', 'next', 'menu'],
  ['menu', 'key_k1', 'one'],
  ['menu', 'key_k2', 'two'],
  ['menu', 'no_input', 'lost'],
  ['menu', 'invalid', 'wrong'],
];
const menuGraph = (extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}) =>
  buildGraph(menuNodes(extra), menuEdges, {
    variables: [{ name: 'choice', type: 'number' }],
    ...more,
  });

describe('advance — keypad menu', () => {
  it('greets, asks and waits with the menu keys', async () => {
    const { last, steps } = await play(menuGraph(), []);
    expect(texts(last.outputs)).toEqual(['Namaste Asha', '1 ya 2 dabaiye']);
    expect(last.outputs.at(-1)).toEqual({
      type: 'listen_dtmf',
      nodeId: 'menu',
      timeoutSec: 7,
      maxDigits: 1,
      finishKey: 'none',
    });
    expect(last.waiting).toEqual({
      kind: 'dtmf',
      nodeId: 'menu',
      timeoutSec: 7,
      mode: 'menu',
      keys: [
        { key: '1', label: 'One' },
        { key: '2', label: 'Two' },
      ],
    });
    expect(last.state).toMatchObject({
      status: 'waiting',
      waitingFor: 'dtmf',
      nodeId: 'menu',
      steps: 3,
    });
    expect(steps[0]?.trace.map((t) => t.event)).toEqual(
      expect.arrayContaining(['input', 'entered', 'exited', 'output']),
    );
  });

  it('a key press follows its exit, saves the value and ends with the hangup', async () => {
    const { last } = await play(menuGraph(), [{ kind: 'dtmf', digits: '1' }]);
    expect(texts(last.outputs)).toEqual(['Bye one']);
    expect(last.outputs.at(-1)).toEqual({ type: 'hangup', nodeId: 'one', reason: 'hangup_node' });
    expect(last.state).toMatchObject({
      status: 'ended',
      endReason: 'hangup_node',
      waitingFor: null,
    });
    expect(last.state.variables).toMatchObject({ choice: 1, last_dtmf: '1', disposition: 'paid' });
    expect(last.state.outcome.disposition).toBe('paid');
    expect(last.waiting).toBeNull();
  });

  it('invalid keys retry with the apology, then take the invalid exit', async () => {
    const { steps } = await play(menuGraph(), [
      { kind: 'dtmf', digits: '7' },
      { kind: 'dtmf', digits: '8' },
      { kind: 'dtmf', digits: '5' },
    ]);
    expect(texts(steps[1]!.outputs)).toEqual([
      'Maaf kijiye, yeh option sahi nahi hai.',
      '1 ya 2 dabaiye',
    ]);
    expect(steps[2]?.state.retries).toBe(2);
    expect(texts(steps[3]!.outputs)).toEqual(['Invalid bye']);
  });

  it('silence retries with its own text, then no_input; retries reset per visit', async () => {
    const { steps } = await play(menuGraph(), [
      { kind: 'no_input' },
      { kind: 'no_input' },
      { kind: 'no_input' },
    ]);
    expect(texts(steps[1]!.outputs)[0]).toBe('Maaf kijiye, mujhe aapka jawab nahi mila.');
    expect(texts(steps[3]!.outputs)).toEqual(['No answer bye']);
    expect(steps[3]?.state.outcome.disposition).toBe('callback_requested');
  });

  it('the repeat key replays the prompt without using a retry', async () => {
    const { steps } = await play(menuGraph(), [
      { kind: 'dtmf', digits: '9' },
      { kind: 'dtmf', digits: '9' },
      { kind: 'dtmf', digits: '2' },
    ]);
    expect(texts(steps[1]!.outputs)).toEqual(['1 ya 2 dabaiye']);
    expect(steps[2]?.state.retries).toBe(0);
    expect(texts(steps[3]!.outputs)).toEqual(['Bye two']);
  });

  it('digits mode: finish key, max digits, too few digits', async () => {
    const digits = buildGraph(
      [
        { id: 'start', type: 'start' },
        {
          id: 'pin',
          type: 'gather_dtmf',
          config: {
            prompt: { kind: 'speak', text: 'Days?' },
            mode: 'digits',
            minDigits: 1,
            maxDigits: 2,
            saveAs: 'days',
            maxRetries: 0,
          },
        },
        { id: 'ok', type: 'speak', config: { text: '{{days}} din' } },
        { id: 'bye', type: 'hangup' },
        { id: 'bad', type: 'hangup', config: { text: 'Bad' } },
      ],
      [
        ['start', 'next', 'pin'],
        ['pin', 'next', 'ok'],
        ['ok', 'next', 'bye'],
        ['pin', 'invalid', 'bad'],
      ],
      { variables: [{ name: 'days', type: 'number' }] },
    );
    const first = await play(digits, []);
    expect(first.last.waiting).toMatchObject({
      kind: 'dtmf',
      mode: 'digits',
      maxDigits: 2,
      finishKey: '#',
    });
    expect(texts((await play(digits, [{ kind: 'dtmf', digits: '12#' }])).last.outputs)).toEqual([
      '12 din',
    ]);
    expect(texts((await play(digits, [{ kind: 'dtmf', digits: '5' }])).last.outputs)).toEqual([
      '5 din',
    ]);
    expect(texts((await play(digits, [{ kind: 'dtmf', digits: '123#' }])).last.outputs)).toEqual([
      'Bad',
    ]);
    expect(texts((await play(digits, [{ kind: 'dtmf', digits: '#' }])).last.outputs)).toEqual([
      'Bad',
    ]);
    expect(texts((await play(digits, [{ kind: 'dtmf', digits: '1#2' }])).last.outputs)).toEqual([
      'Bad',
    ]);
  });
});

describe('advance — inputs and end reasons', () => {
  it('refuses inputs that do not match, and inputs after the end', async () => {
    const { last } = await play(menuGraph(), []);
    const { ctx } = testContext();
    await expect(
      advance(
        menuGraph(),
        last.state,
        { kind: 'speech', text: 'x', inputId: 'z' },
        fakeEffects(),
        ctx,
      ),
    ).rejects.toBeInstanceOf(InputMismatchError);
    const ended = (await play(menuGraph(), [{ kind: 'dtmf', digits: '1' }])).last.state;
    await expect(
      advance(menuGraph(), ended, { kind: 'dtmf', digits: '1', inputId: 'z' }, fakeEffects(), ctx),
    ).rejects.toBeInstanceOf(RunEndedError);
    await expect(
      advance(menuGraph(), null, { kind: 'dtmf', digits: '1', inputId: 'z' }, fakeEffects(), ctx),
    ).rejects.toBeInstanceOf(RunEndedError);
    const err = new InputMismatchError(null, 'timer');
    expect(err.message).toBe('Not waiting for input');
  });

  it('customer hangup mid-gather ends without a goodbye', async () => {
    const { last } = await play(menuGraph(), [{ kind: 'hangup' }]);
    expect(last.outputs).toEqual([]);
    expect(last.state).toMatchObject({ status: 'ended', endReason: 'customer_hangup' });
  });

  it('max duration ends the run on the next input', async () => {
    const setup = testContext();
    const g = menuGraph({}, { settings: { maxDurationSec: 60 } });
    const first = await advance(
      g,
      null,
      { kind: 'start', trigger: 'test', inputId: 'a' },
      fakeEffects(),
      setup.ctx,
    );
    setup.clock.advance(61_000);
    const next = await advance(
      g,
      first.state,
      { kind: 'dtmf', digits: '1', inputId: 'b' },
      fakeEffects(),
      setup.ctx,
    );
    expect(next.state.endReason).toBe('max_duration');
    expect(next.outputs).toEqual([{ type: 'hangup', nodeId: 'menu', reason: 'max_duration' }]);
  });

  it('too many inputs end the run', async () => {
    const { last } = await play(menuGraph(), []);
    const state = { ...last.state, inputs: FLOW_LIMITS.inputsPerRunMax };
    const { ctx } = testContext();
    const next = await advance(
      menuGraph(),
      state,
      { kind: 'dtmf', digits: '9', inputId: 'x' },
      fakeEffects(),
      ctx,
    );
    expect(next.state.endReason).toBe('inputs_exhausted');
  });

  it('a graph without start / a missing current node is an engine error', async () => {
    const { ctx } = testContext();
    const noStart = buildGraph([{ id: 'bye', type: 'hangup' }], []);
    const r = await advance(
      noStart,
      null,
      { kind: 'start', trigger: 'test', inputId: 'a' },
      fakeEffects(),
      ctx,
    );
    expect(r.state.endReason).toBe('engine_error');
    const { last } = await play(menuGraph(), []);
    const lost = await advance(
      menuGraph(),
      { ...last.state, nodeId: 'ghost' },
      { kind: 'dtmf', digits: '1', inputId: 'b' },
      fakeEffects(),
      ctx,
    );
    expect(lost.state.endReason).toBe('engine_error');
  });

  it('an exception inside an effect ends the run as engine_error (name only)', async () => {
    const g = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 'api', type: 'api_request', config: { url: 'https://x' } },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'api'],
        ['api', 'success', 'bye'],
      ],
    );
    const effects = fakeEffects({ callApi: () => Promise.reject(new TypeError('boom secret')) });
    const { last } = await play(g, [], effects);
    expect(last.state.endReason).toBe('engine_error');
    expect(last.error).toBe('TypeError');
    expect(JSON.stringify(last.trace)).not.toContain('boom secret');
  });
});

describe('advance — errors, guards, determinism', () => {
  it('an unconfigured node takes its error exit; without one the flow error handler hangs up', async () => {
    const withError = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 's', type: 'speak', config: { text: '' } },
        { id: 'oops', type: 'hangup', config: { text: 'Oops' } },
      ],
      [
        ['start', 'next', 's'],
        ['s', 'error', 'oops'],
      ],
    );
    expect(texts((await play(withError, [])).last.outputs)).toEqual(['Oops']);
    const without = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 's', type: 'speak', config: { text: '' } },
      ],
      [['start', 'next', 's']],
    );
    const r = (await play(without, [])).last;
    expect(texts(r.outputs)).toEqual([DEFAULT_ERROR_MESSAGE]);
    expect(r.state.endReason).toBe('error_handler');
  });

  it('the error handler can transfer; any transfer result ends the run', async () => {
    const g = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 's', type: 'speak', config: { text: '' } },
      ],
      [['start', 'next', 's']],
      {
        settings: { onError: 'transfer', errorTransferPhone: '+919876543210' },
      },
    );
    const first = (await play(g, [])).last;
    expect(first.waiting).toMatchObject({ kind: 'transfer', transferPhoneLast4: '3210' });
    expect(first.outputs.at(-1)).toMatchObject({ type: 'transfer', phone: '+919876543210' });
    expect(
      (await play(g, [{ kind: 'transfer_result', result: 'connected' }])).last.state.endReason,
    ).toBe('transferred');
    expect(
      (await play(g, [{ kind: 'transfer_result', result: 'failed' }])).last.state.endReason,
    ).toBe('error_handler');
  });

  it('a silent loop is stopped by the loop guard', async () => {
    const g = buildGraph(
      [
        { id: 'start', type: 'start' },
        {
          id: 'a',
          type: 'set_variable',
          config: { assignments: [{ variable: 'n', op: 'increment', value: '1' }] },
        },
        {
          id: 'b',
          type: 'condition_router',
          config: {
            rules: [{ id: 'r1', conditions: [{ variable: 'n', operator: 'gt', value: '1000' }] }],
          },
        },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'a'],
        ['a', 'next', 'b'],
        ['b', 'else', 'a'],
        ['b', 'rule_r1', 'bye'],
      ],
      { variables: [{ name: 'n', type: 'number', default: 0 }] },
    );
    const r = (await play(g, [])).last;
    expect(r.state.endReason).toBe('loop_guard');
    expect(texts(r.outputs)).toEqual([DEFAULT_ERROR_MESSAGE]);
    expect(r.state.steps).toBeLessThanOrEqual(FLOW_LIMITS.autoStepsMax + 1);
  });

  it('a waiting loop is stopped by the visits guard', async () => {
    const g = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 'w', type: 'wait', config: { seconds: 1 } },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 'w'],
        ['w', 'next', 'w'],
      ],
    );
    let r = (await play(g, [])).last;
    const { ctx } = testContext();
    for (let i = 0; i < FLOW_LIMITS.visitsPerNodeMax && r.state.status !== 'ended'; i += 1) {
      r = await advance(
        g,
        r.state,
        { kind: 'timer', inputId: `t${String(i)}` },
        fakeEffects(),
        ctx,
      );
    }
    expect(r.state.endReason).toBe('loop_guard');
  });

  it('is deterministic and its state survives JSON between every step', async () => {
    const inputs: FlowInputBody[] = [
      { kind: 'dtmf', digits: '7' },
      { kind: 'no_input' },
      { kind: 'dtmf', digits: '2' },
    ];
    const a = await play(menuGraph(), inputs, fakeEffects(), testContext(fixedClock()));
    const b = await play(menuGraph(), inputs, fakeEffects(), testContext(fixedClock()));
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
    for (const step of a.steps) expect(JSON.parse(JSON.stringify(step.state))).toEqual(step.state);
    // the previous state object is never mutated
    const before = JSON.stringify(a.steps[0]!.state);
    await advance(
      menuGraph(),
      a.steps[0]!.state,
      { kind: 'dtmf', digits: '1', inputId: 'x' },
      fakeEffects(),
      testContext().ctx,
    );
    expect(JSON.stringify(a.steps[0]!.state)).toBe(before);
  });

  it('records node stats and call-mode traces carry no texts', async () => {
    const setup = testContext(fixedClock(), 'call');
    const { all, steps } = await play(
      menuGraph(),
      [{ kind: 'dtmf', digits: '1' }],
      fakeEffects(),
      setup,
    );
    expect(texts(all)).toContain('Namaste Asha');
    const trace = JSON.stringify(steps.map((s) => s.trace));
    expect(trace).not.toContain('Asha');
    expect(trace).not.toContain('Bye one');
    expect(setup.stats.events).toEqual(
      expect.arrayContaining([
        { nodeId: 'start', event: 'enter' },
        { nodeId: 'menu', event: 'exit', handle: 'key_k1', ms: 0 },
        { nodeId: 'one', event: 'exit', handle: 'end', ms: 0 },
      ]),
    );
  });

  it('initial state: flow variable defaults (bad ones null), system variables, clock', () => {
    const g = buildGraph([{ id: 'start', type: 'start' }], [], {
      variables: [
        { name: 'tries', type: 'number', default: 3 },
        { name: 'bad', type: 'date', default: 'tomorrow' },
        { name: 'none', type: 'text' },
      ],
    });
    const s = initialState(g, { now: fixedClock().now, company: 'Acme' }, 'campaign', {
      name: 'A',
    });
    expect(s.variables).toMatchObject({
      tries: 3,
      bad: null,
      none: null,
      company: 'Acme',
      promise_date: null,
    });
    expect(s).toMatchObject({
      trigger: 'campaign',
      contact: { name: 'A' },
      startedAt: '2026-10-10T06:30:00.000Z',
    });
  });

  it('today / now_time follow the account timezone', async () => {
    const g = buildGraph(
      [
        { id: 'start', type: 'start' },
        { id: 's', type: 'speak', config: { text: '{{today}} {{now_time}}' } },
        { id: 'bye', type: 'hangup' },
      ],
      [
        ['start', 'next', 's'],
        ['s', 'next', 'bye'],
      ],
    );
    const late = testContext(fixedClock('2026-10-10T18:30:00Z')); // 00:00 IST on 11 Oct
    expect(texts((await play(g, [], fakeEffects(), late)).last.outputs)).toEqual([
      '11 Oct 2026 00:00',
    ]);
    const early = testContext(fixedClock('2026-10-10T18:29:59Z'));
    expect(texts((await play(g, [], fakeEffects(), early)).last.outputs)).toEqual([
      '10 Oct 2026 23:59',
    ]);
  });
});
