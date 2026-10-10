/** Engine test helpers: graph builder, fixed clock, fake effects. */
import { FlowGraphSchema, type FlowGraph } from '../../src/core/engine/schema';
import { memoryStatsRecorder } from '../../src/core/engine/stats';
import type { AiTurnResult, EngineContext, FlowEffects } from '../../src/core/engine/types';

export type RawNode = {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
};
export type RawEdge = [string, string, string];

export const buildGraph = (
  nodes: RawNode[],
  edges: RawEdge[],
  extra: Record<string, unknown> = {},
): FlowGraph =>
  FlowGraphSchema.parse({
    schemaVersion: 1,
    nodes: nodes.map((n, i) => ({ position: { x: 0, y: i * 100 }, config: {}, ...n })),
    edges: edges.map(([source, sourceHandle, target], i) => ({
      id: `e${String(i)}`,
      source,
      sourceHandle,
      target,
    })),
    ...extra,
  });

export const fixedClock = (iso = '2026-10-10T06:30:00Z') => {
  let t = Date.parse(iso);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
};

export const testContext = (clock = fixedClock(), mode: 'simulator' | 'call' = 'simulator') => {
  const stats = memoryStatsRecorder();
  const ctx: EngineContext = {
    now: clock.now,
    timezone: 'Asia/Kolkata',
    company: 'Acme Finance',
    mode,
    stats,
  };
  return { ctx, stats, clock };
};

export const reply = (text: string, extra: Partial<AiTurnResult> = {}): AiTurnResult => ({
  text,
  outcome: {},
  ended: false,
  fallback: null,
  guardrail: null,
  toolCalls: [],
  knowledge: [],
  costMicros: 1000,
  ...extra,
});

/** Effects with sensible fakes; override per test. */
export const fakeEffects = (overrides: Partial<FlowEffects> = {}): FlowEffects => ({
  callApi: () =>
    Promise.resolve({ ok: true, status: 200, body: { status: 'paid' }, durationMs: 5 }),
  aiStart: () =>
    Promise.resolve({ ok: true, text: 'Namaste, main AI assistant hoon.', reason: null }),
  aiTurn: ({ userText }) => Promise.resolve(reply(`You said: ${userText}`)),
  classifyIntent: () => Promise.resolve(null),
  loadAudio: (id) =>
    Promise.resolve(id === 'aaaaaaaaaaaaaaaaaaaaaaaa' ? { id, name: 'Welcome' } : null),
  ...overrides,
});
