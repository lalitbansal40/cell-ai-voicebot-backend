/**
 * Flow engine bench (`npm run bench:flow [calls]`): the largest allowed graph
 * (150 nodes: a chain of keypad menus + routers + set-variable nodes), many
 * `advance` calls with fake effects → p50 / p95 / p99 (µs), plus
 * `validateFlow` on the same graph. Pure — no database, refuses production.
 */
import { performance } from 'node:perf_hooks';

import { FLOW_LIMITS } from '../src/config/limits';
import { advance } from '../src/core/engine/engine';
import { FlowGraphSchema } from '../src/core/engine/schema';
import { memoryStatsRecorder } from '../src/core/engine/stats';
import type { FlowEffects, FlowRunState } from '../src/core/engine/types';
import { validateFlow } from '../src/core/engine/validate';

if (process.env.NODE_ENV === 'production') {
  console.error('bench:flow refuses to run in production');
  process.exit(1);
}

const CALLS = Number(process.argv[2] ?? 10_000);

const buildGraph = () => {
  const nodes: Record<string, unknown>[] = [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
  ];
  const edges: Record<string, unknown>[] = [];
  let prev = 'start';
  let handle = 'next';
  const link = (id: string, nextHandle: string) => {
    edges.push({ id: `e${String(edges.length)}`, source: prev, sourceHandle: handle, target: id });
    prev = id;
    handle = nextHandle;
  };
  for (let i = 0; nodes.length + 3 <= FLOW_LIMITS.nodesMax - 1; i += 1) {
    const g = `g${String(i)}`;
    nodes.push({
      id: g,
      type: 'gather_dtmf',
      position: { x: 0, y: nodes.length * 100 },
      config: {
        prompt: { kind: 'speak', text: 'Namaste {{name}}, 1 dabaiye' },
        keys: [{ id: 'k1', key: '1' }],
        saveAs: 'n',
      },
    });
    link(g, 'key_k1');
    const s = `s${String(i)}`;
    nodes.push({
      id: s,
      type: 'set_variable',
      position: { x: 0, y: nodes.length * 100 },
      config: { assignments: [{ variable: 'count', op: 'increment', value: '1' }] },
    });
    link(s, 'next');
    const r = `r${String(i)}`;
    nodes.push({
      id: r,
      type: 'condition_router',
      position: { x: 0, y: nodes.length * 100 },
      config: {
        rules: [{ id: 'r1', conditions: [{ variable: 'count', operator: 'gt', value: '1000' }] }],
      },
    });
    link(r, 'else');
    edges.push({
      id: `e${String(edges.length)}`,
      source: r,
      sourceHandle: 'rule_r1',
      target: 'bye',
    });
  }
  nodes.push({ id: 'bye', type: 'hangup', position: { x: 0, y: 0 }, config: { text: 'Bye' } });
  edges.push({ id: `e${String(edges.length)}`, source: prev, sourceHandle: handle, target: 'bye' });
  return FlowGraphSchema.parse({
    schemaVersion: 1,
    nodes,
    edges,
    variables: [
      { name: 'n', type: 'number' },
      { name: 'count', type: 'number', default: 0 },
    ],
  });
};

const effects: FlowEffects = {
  callApi: () => Promise.resolve({ ok: true, status: 200, body: {}, durationMs: 0 }),
  aiStart: () => Promise.resolve({ ok: true, text: null, reason: null }),
  aiTurn: () => Promise.reject(new Error('unused')),
  classifyIntent: () => Promise.resolve(null),
  loadAudio: () => Promise.resolve(null),
};

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;

const main = async () => {
  const graph = buildGraph();
  const ctx = {
    now: () => new Date(),
    timezone: 'Asia/Kolkata',
    company: 'Bench Co',
    mode: 'call' as const,
    stats: memoryStatsRecorder(),
  };
  const times: number[] = [];
  let state: FlowRunState | null = null;
  for (let i = 0; i < CALLS; i += 1) {
    const t0 = performance.now();
    const r = await advance(
      graph,
      state,
      state === null
        ? { kind: 'start', trigger: 'test', inputId: `s${String(i)}` }
        : { kind: 'dtmf', digits: '1', inputId: `d${String(i)}` },
      effects,
      ctx,
      { name: 'Asha' },
    );
    times.push((performance.now() - t0) * 1000);
    state = r.state.status === 'ended' ? null : r.state;
    if (ctx.stats.events.length > 10_000) ctx.stats.events.length = 0;
  }
  times.sort((a, b) => a - b);
  const v0 = performance.now();
  const issues = validateFlow(graph, {
    contactVars: [{ name: 'name', label: 'Name', type: 'built_in' }],
    agents: new Map(),
    audios: new Set(),
    urlPolicy: { httpsOnly: true, allowPrivate: false },
  });
  const validateMs = performance.now() - v0;
  console.info(
    JSON.stringify(
      {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        advanceCalls: CALLS,
        advanceUs: {
          p50: Math.round(percentile(times, 50)),
          p95: Math.round(percentile(times, 95)),
          p99: Math.round(percentile(times, 99)),
        },
        validateMs: Math.round(validateMs * 10) / 10,
        validateErrors: issues.filter((i) => i.severity === 'error').length,
      },
      null,
      2,
    ),
  );
};

void main();
