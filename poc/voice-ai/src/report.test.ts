import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMetricsMarkdown } from './report.ts';

const summary = (id: string, latencies: number[], pass = true) => ({
  scenarioId: id,
  title: id,
  mode: 'pcm24k',
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  callMs: 60_000,
  costUsd: { total: 0.05 },
  costPerMinUsd: 0.05,
  latencyMs: { p50: latencies[0], p95: latencies.at(-1), all: latencies },
  checks: [
    { name: 'check_payment_status called', pass },
    { name: 'language matches (hi)', pass },
  ],
  passed: pass ? 2 : 0,
  total: 2,
});

describe('buildMetricsMarkdown', () => {
  it('renders per-scenario rows, aggregates and thresholds', () => {
    const md = buildMetricsMarkdown(
      [summary('05-paid-claim-paid', [800, 900]), summary('07-barge-in', [1000])],
      84,
      'run1',
    );
    assert.match(md, /\| 05-paid-claim-paid \| pcm24k/);
    assert.match(md, /Aggregates by model × mode/);
    assert.match(md, /\| Latency p50 \| ≤ 1200 ms \| 900 ms \| ✅ \|/);
    assert.match(md, /₹\/min/);
  });

  it('marks failed thresholds', () => {
    const md = buildMetricsMarkdown(
      [summary('05-paid-claim-paid', [2500, 3000], false)],
      84,
      'run2',
    );
    assert.match(md, /\| Latency p50 \| ≤ 1200 ms \| 2500 ms \| ❌ \|/);
    assert.match(md, /Function-call scenarios \| 100% pass \| failures \| ❌/);
  });
});
