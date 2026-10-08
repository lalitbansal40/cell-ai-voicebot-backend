/**
 * Aggregates output/<runId>/*\/summary.json into the metrics section of
 * docs/poc/voice-ai-poc-results.md (between the METRICS markers).
 *
 *   npm run report -- --run <runId> [--usd-inr 96.83]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { OUTPUT_DIR, POC_ROOT } from './config.ts';

interface Summary {
  scenarioId: string;
  title: string;
  mode: string;
  model: string;
  voice: string;
  callMs: number;
  aborted?: string;
  costUsd: { total: number };
  costPerMinUsd: number;
  latencyMs: { p50?: number; p95?: number; all: number[] };
  checks: { name: string; pass: boolean; detail?: string }[];
  passed: number;
  total: number;
}

const RESULTS_DOC = path.resolve(POC_ROOT, '..', '..', 'docs', 'poc', 'voice-ai-poc-results.md');
const START = '<!-- METRICS:START -->';
const END = '<!-- METRICS:END -->';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const pct = (values: number[], p: number): number | undefined => {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const fmt = (n: number | undefined, digits = 0) => (n === undefined ? '–' : n.toFixed(digits));

export const buildMetricsMarkdown = (
  summaries: Summary[],
  usdInr: number,
  runId: string,
): string => {
  const lines: string[] = [
    `_Generated from run \`${runId}\` on ${new Date().toISOString()} — USD→INR ${usdInr}._`,
    '',
  ];

  lines.push('### Per scenario', '');
  lines.push(
    '| Scenario | Mode | Model | Voice | Checks | p50 ms | p95 ms | Call s | Cost $ | $/min | Notes |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of summaries) {
    const failed = s.checks.filter((c) => !c.pass).map((c) => c.name);
    const notes = [
      s.aborted ? `aborted: ${s.aborted}` : '',
      failed.length ? `failed: ${failed.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(
      `| ${s.scenarioId} | ${s.mode} | ${s.model} | ${s.voice} | ${s.passed}/${s.total} | ${fmt(s.latencyMs.p50)} | ${fmt(s.latencyMs.p95)} | ${fmt(s.callMs / 1000, 1)} | ${fmt(s.costUsd.total, 4)} | ${fmt(s.costPerMinUsd, 4)} | ${notes} |`,
    );
  }

  lines.push('', '### Aggregates by model × mode', '');
  lines.push(
    '| Model | Mode | Runs | Checks passed | Latency p50 ms | Latency p95 ms | Avg $/min | Avg ₹/min |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const groups = new Map<string, Summary[]>();
  for (const s of summaries) {
    const key = `${s.model}|${s.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [key, group] of groups) {
    const [model, mode] = key.split('|');
    const latencies = group.flatMap((s) => s.latencyMs.all);
    const passed = group.reduce((n, s) => n + s.passed, 0);
    const total = group.reduce((n, s) => n + s.total, 0);
    const totalMin = group.reduce((n, s) => n + s.callMs / 60_000, 0);
    const totalUsd = group.reduce((n, s) => n + s.costUsd.total, 0);
    const perMin = totalMin > 0 ? totalUsd / totalMin : 0;
    lines.push(
      `| ${model} | ${mode} | ${group.length} | ${passed}/${total} (${fmt((passed / Math.max(total, 1)) * 100)}%) | ${fmt(pct(latencies, 50))} | ${fmt(pct(latencies, 95))} | ${fmt(perMin, 4)} | ${fmt(perMin * usdInr, 2)} |`,
    );
  }

  const all = summaries.flatMap((s) => s.latencyMs.all);
  const langChecks = summaries.flatMap((s) => s.checks.filter((c) => c.name.includes('language')));
  const toolScenarios = summaries.filter((s) => /^0[45]-/.test(s.scenarioId));
  const bargeIn = summaries.filter((s) => s.scenarioId.startsWith('07-'));
  lines.push('', '### Go / No-go thresholds', '');
  lines.push('| Threshold | Target | Result | Pass |', '| --- | --- | --- | --- |');
  const row = (name: string, target: string, value: string, pass: boolean) =>
    lines.push(`| ${name} | ${target} | ${value} | ${pass ? '✅' : '❌'} |`);
  const p50 = pct(all, 50);
  const p95 = pct(all, 95);
  row('Latency p50', '≤ 1200 ms', `${fmt(p50)} ms`, p50 !== undefined && p50 <= 1200);
  row('Latency p95', '≤ 2000 ms', `${fmt(p95)} ms`, p95 !== undefined && p95 <= 2000);
  const langPass = langChecks.filter((c) => c.pass).length / Math.max(langChecks.length, 1);
  row(
    'Language match',
    '≥ 90% of turns',
    `${fmt(langPass * 100)}%`,
    langChecks.length > 0 && langPass >= 0.9,
  );
  const toolPass = toolScenarios.every((s) =>
    s.checks.filter((c) => c.name.includes('called')).every((c) => c.pass),
  );
  row(
    'Function-call scenarios',
    '100% pass',
    toolScenarios.length ? (toolPass ? 'all pass' : 'failures') : 'not run',
    toolScenarios.length > 0 && toolPass,
  );
  const bargePass = bargeIn.length > 0 && bargeIn.every((s) => s.checks[0]?.pass);
  row(
    'Barge-in',
    'works',
    bargeIn.length ? (bargePass ? 'works' : 'failed') : 'not run',
    bargePass,
  );
  return lines.join('\n');
};

const main = (): void => {
  if (!existsSync(OUTPUT_DIR)) throw new Error('No output/ folder yet — run `npm run run` first.');
  const runId =
    arg('run') ??
    readdirSync(OUTPUT_DIR)
      .filter((d) => /^\d{4}-/.test(d))
      .sort()
      .at(-1);
  if (!runId) throw new Error('No run found in output/. Pass --run <runId>.');
  const usdInr = Number(arg('usd-inr') ?? '96.83');
  const runDir = path.join(OUTPUT_DIR, runId);
  if (!existsSync(runDir)) throw new Error(`Run folder not found: ${runDir}`);
  const summaries = readdirSync(runDir)
    .map((d) => path.join(runDir, d, 'summary.json'))
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, 'utf8')) as Summary)
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.mode.localeCompare(b.mode));
  const md = buildMetricsMarkdown(summaries, usdInr, runId);
  const doc = readFileSync(RESULTS_DOC, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`Markers not found in ${RESULTS_DOC}`);
  writeFileSync(RESULTS_DOC, `${doc.slice(0, start + START.length)}\n\n${md}\n\n${doc.slice(end)}`);
  console.info(
    `Updated ${path.relative(process.cwd(), RESULTS_DOC)} with ${summaries.length} scenario runs.`,
  );
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(POC_ROOT, 'src', 'report.ts')
) {
  main();
}
