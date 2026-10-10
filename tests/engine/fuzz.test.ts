import { describe, expect, it } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import { InputMismatchError, advance } from '../../src/core/engine/engine';
import { exitsOf } from '../../src/core/engine/exits';
import type { FlowInputBody } from '../../src/core/engine/types';
import {
  buildGraph,
  fakeEffects,
  reply,
  testContext,
  type RawEdge,
  type RawNode,
} from '../helpers/engine';

/** mulberry32 — seeded, deterministic. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const NODE_FACTORIES: ((id: string) => RawNode)[] = [
  (id) => ({ id, type: 'speak', config: { text: `Hi {{name}} ${id}` } }),
  (id) => ({
    id,
    type: 'gather_dtmf',
    config: {
      prompt: { kind: 'speak', text: 'press' },
      keys: [
        { id: 'k1', key: '1' },
        { id: 'k2', key: '2' },
      ],
      maxRetries: 1,
    },
  }),
  (id) => ({
    id,
    type: 'gather_speech',
    config: {
      prompt: { kind: 'speak', text: 'say' },
      intents: [{ id: 'yes', label: 'Yes', keywords: ['haan'] }],
    },
  }),
  (id) => ({ id, type: 'ai_agent', config: { agentId: 'b'.repeat(24), maxTurns: 2 } }),
  (id) => ({
    id,
    type: 'api_request',
    config: { url: 'https://x', saveResponse: [{ path: 'status', variable: 'v' }] },
  }),
  (id) => ({
    id,
    type: 'condition_router',
    config: {
      rules: [{ id: 'r1', conditions: [{ variable: 'v', operator: 'equals', value: 'paid' }] }],
    },
  }),
  (id) => ({
    id,
    type: 'set_variable',
    config: { assignments: [{ variable: 'n', op: 'increment', value: '1' }] },
  }),
  (id) => ({ id, type: 'set_disposition', config: { disposition: 'other' } }),
  (id) => ({ id, type: 'send_sms', config: { text: 'sms' } }),
  (id) => ({ id, type: 'wait', config: { seconds: 2 } }),
  (id) => ({ id, type: 'transfer_to_agent', config: { phone: '+919876543210' } }),
  (id) => ({ id, type: 'hangup' }),
  (id) => ({ id, type: 'speak', config: { text: '' } }), // unconfigured
];

const INPUTS: FlowInputBody[] = [
  { kind: 'dtmf', digits: '1' },
  { kind: 'dtmf', digits: '7' },
  { kind: 'speech', text: 'haan' },
  { kind: 'speech', text: 'nahi' },
  { kind: 'no_input' },
  { kind: 'timer' },
  { kind: 'transfer_result', result: 'failed' },
  { kind: 'transfer_result', result: 'connected' },
];

const randomGraph = (rand: () => number) => {
  const count = 2 + Math.floor(rand() * 12);
  const nodes: RawNode[] = [{ id: 'start', type: 'start' }];
  for (let i = 0; i < count; i += 1) {
    nodes.push(NODE_FACTORIES[Math.floor(rand() * NODE_FACTORIES.length)]!(`n${String(i)}`));
  }
  const edges: RawEdge[] = [];
  const graph0 = buildGraph(nodes, []);
  for (const node of graph0.nodes) {
    for (const exit of exitsOf(node)) {
      if (rand() < 0.8)
        edges.push([node.id, exit.handle, `n${String(Math.floor(rand() * count))}`]);
    }
  }
  return buildGraph(nodes, edges, {
    variables: [
      { name: 'v', type: 'text' },
      { name: 'n', type: 'number' },
    ],
  });
};

describe('engine fuzz (seeded)', () => {
  it('300 random graphs × 50 random inputs never throw and always wait or end', async () => {
    const rand = prng(20261010);
    const effects = fakeEffects({
      aiTurn: () =>
        Promise.resolve(reply('ok', rand() < 0.3 ? { outcome: { endRequested: true } } : {})),
      callApi: () =>
        Promise.resolve(
          rand() < 0.5
            ? { ok: true, status: 200, body: { status: 'paid' }, durationMs: 1 }
            : { ok: false, error: 'timeout', durationMs: 1 },
        ),
    });
    for (let g = 0; g < 300; g += 1) {
      const graph = randomGraph(rand);
      const { ctx } = testContext();
      let r = await advance(
        graph,
        null,
        { kind: 'start', trigger: 'test', inputId: 's' },
        effects,
        ctx,
      );
      for (let i = 0; i < 50 && r.state.status !== 'ended'; i += 1) {
        const input = INPUTS[Math.floor(rand() * INPUTS.length)]!;
        try {
          r = await advance(graph, r.state, { ...input, inputId: `i${String(i)}` }, effects, ctx);
        } catch (err) {
          expect(err).toBeInstanceOf(InputMismatchError);
        }
      }
      expect(r.error).toBeUndefined();
      expect(['waiting', 'ended']).toContain(r.state.status);
      expect(r.state.steps).toBeLessThanOrEqual(FLOW_LIMITS.stepsPerRunMax + 1);
      if (r.state.status === 'waiting') expect(r.waiting).not.toBeNull();
    }
  });
});
