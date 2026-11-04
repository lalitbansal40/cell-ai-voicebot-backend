/**
 * SIP load (T18.19): N calls at once on the lab trunk (`npm run sip:lab`), each answered by
 * SIPp (RTP echo), the bot streaming audio the whole time. Measures this process's CPU and
 * event-loop lag, Asterisk's CPU / memory, RTP loss / jitter per call, and leaked ports.
 *
 *   npm run perf:sip -- --calls 30 --seconds 60
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { AriClient } from '../src/core/telephony/sip/ari-client';
import type { SipCallLeg } from '../src/core/telephony/sip/leg';
import { PortPool } from '../src/core/telephony/sip/port-pool';
import { SipTelephonyProvider } from '../src/core/telephony/sip/provider';
import { tone } from '../src/core/voice/audio/pcm';
import { systemClock } from '../src/core/voice/clock';

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const CALLS = arg('calls', 30);
const SECONDS = arg('seconds', 60);
const lab = path.resolve(__dirname, '../deploy/asterisk/lab');
const password =
  /^ARI_PASSWORD\s*=\s*(\S+)/m.exec(readFileSync(path.join(lab, '.env.lab'), 'utf8'))?.[1] ?? '';
const advertise =
  process.env.SIP_LAB_ADVERTISE ??
  execFileSync(
    'docker',
    ['exec', 'cav-sip-lab-asterisk', 'getent', 'ahostsv4', 'host.docker.internal'],
    {
      encoding: 'utf8',
    },
  ).split(/\s+/)[0]!;

const dockerStats = () =>
  execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', 'cav-sip-lab-asterisk'],
    {
      encoding: 'utf8',
    },
  ).trim();

const main = async () => {
  const ari = new AriClient({
    url: 'http://127.0.0.1:18088',
    user: 'cav',
    password,
    app: 'cav-perf',
  });
  ari.connect();
  for (let i = 0; i < 200 && !ari.connected; i += 1) await new Promise((r) => setTimeout(r, 50));
  if (!ari.connected) throw new Error('lab ARI not reachable: npm run sip:lab');
  const pool = new PortPool(36000, 36199);
  const line = new SipTelephonyProvider(ari, pool, systemClock, {
    trunk: 'trunk',
    format: 'ulaw',
    ringTimeoutSec: 10,
    mediaTimeoutSec: 30,
    rtpBindHost: process.env.SIP_LAB_BIND ?? '127.0.0.1',
    advertiseHost: advertise,
    asteriskRtpHost: '127.0.0.1',
    defaultCallerId: '+911600000000',
    app: 'cav-perf',
  });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  const legs: SipCallLeg[] = [];
  const answered: Promise<boolean>[] = [];
  for (let i = 0; i < CALLS; i += 1) {
    const leg = await line.startCall({
      callId: `perf${String(t0)}x${String(i)}`,
      to: '+919000000001',
    });
    legs.push(leg);
    answered.push(
      new Promise((resolve) => {
        setTimeout(() => resolve(false), 15_000);
        leg.onStatus((s) => {
          if (s === 'answered') resolve(true);
          if (s === 'ended') resolve(false);
        });
      }),
    );
    await leg.dial();
  }
  const up = (await Promise.all(answered)).filter(Boolean).length;
  // the bot talks for the whole call (worst case for RTP out + echo back in)
  const clip = tone(1000, 8000, { amplitude: 6000 });
  const talking = legs.map(async (leg) => {
    const end = Date.now() + SECONDS * 1000;
    while (!leg.ended && Date.now() < end) await leg.play(clip);
  });
  await new Promise((r) => setTimeout(r, (SECONDS * 1000) / 2));
  const asterisk = dockerStats();
  await Promise.all(talking);
  const ended = legs.filter((l) => l.ended).length;
  await Promise.all(legs.map((l) => l.hangup('normal')));
  for (let i = 0; i < 100 && line.live > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  const cpu = process.cpuUsage(cpu0);
  const wall = (Date.now() - t0) / 1000;
  lag.disable();
  const m = legs.map((l) => l.metrics);
  const avg = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;
  const result = {
    calls: CALLS,
    answered: up,
    droppedBeforeEnd: ended,
    seconds: SECONDS,
    nodeCpuPct: Math.round(((cpu.user + cpu.system) / 1e6 / wall) * 1000) / 10,
    eventLoopLagP99Ms: Math.round(lag.percentile(99) / 1e6),
    asteriskCpuMem: asterisk,
    packetsOutAvg: avg(m.map((x) => x.packetsOut)),
    packetsInAvg: avg(m.map((x) => x.packetsIn)),
    lossPctAvg: avg(m.map((x) => x.lossPct)),
    lossPctMax: Math.max(...m.map((x) => x.lossPct)),
    jitterMsAvg: avg(m.map((x) => x.jitterMs)),
    leakedPorts: pool.leased,
    liveLegsLeft: line.live,
  };
  console.info(JSON.stringify(result, null, 2));
  ari.close();
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
