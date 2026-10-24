/**
 * DEV TOOL — WhatsApp call media PoC (PHASE_12_PLAN §1b, ADR 0040).
 * Our business WebRTC peer ⇄ a Meta-like ICE-lite peer on 127.0.0.1: setup,
 * two-way Opus tones, RFC 4733 DTMF, silent keep-alive; numbers for 1 / 10 / 20
 * parallel calls. Usage: `npm run poc:wa-call [-- --runs 20 --silence 30000]`.
 */
import { runLoopbackCall, type LoopbackResult } from '../src/core/telephony/whatsapp/loopback';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};

const ok = (r: LoopbackResult): boolean =>
  r.businessHeardMeta &&
  r.metaHeardBusiness &&
  r.digitsReceived === '123' &&
  r.silencePackets > 0 &&
  r.stillConnected;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

const parallel = async (n: number, silenceMs: number) => {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const rss0 = process.memoryUsage().rss;
  let peakRss = rss0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  const results = await Promise.all(
    Array.from({ length: n }, () => runLoopbackCall({ toneMs: 2_000, silenceMs })),
  );
  clearInterval(sampler);
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  // each call runs two peers (ours + the fake Meta side): half the CPU is ours
  const cpuPctPerCall = (((cpu.user + cpu.system) / 1000 / wallMs) * 100) / n / 2;
  return {
    calls: n,
    passed: results.filter(ok).length,
    setupMsMedian: Math.round(median(results.map((r) => r.setupMs))),
    latencyMsMedian: Number(median(results.map((r) => r.pipelineMs)).toFixed(2)),
    latencyBackMsMedian: Number(median(results.map((r) => r.pipelineBackMs)).toFixed(2)),
    jitterMsMedian: Number(median(results.map((r) => r.jitterMs)).toFixed(2)),
    cpuPctOfOneCorePerCall: Number(cpuPctPerCall.toFixed(2)),
    extraRssMbPerCall: Number(((peakRss - rss0) / 1024 / 1024 / n / 2).toFixed(1)),
  };
};

void (async () => {
  const runs = arg('runs', 20);
  const silence = arg('silence', 30_000);
  let passed = 0;
  const setups: number[] = [];
  const latencies: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const r = await runLoopbackCall({ toneMs: 2_000, silenceMs: 1_000 });
    if (ok(r)) passed += 1;
    setups.push(r.setupMs);
    latencies.push(r.pipelineMs, r.pipelineBackMs);
  }
  console.log(
    `sequential: ${String(passed)} / ${String(runs)} passed, setup median ${String(Math.round(median(setups)))} ms, encode→network→decode median ${median(latencies).toFixed(2)} ms`,
  );
  const keepAlive = await runLoopbackCall({ toneMs: 1_000, silenceMs: silence });
  console.log(
    `keep-alive ${String(silence / 1000)} s: ${keepAlive.silencePackets} packets, connected ${String(keepAlive.stillConnected)}`,
  );
  for (const n of [1, 10, 20]) console.log(JSON.stringify(await parallel(n, 1_000)));
  process.exit(0);
})().catch((err: unknown) => {
  console.error('PoC failed', err);
  process.exit(1);
});
