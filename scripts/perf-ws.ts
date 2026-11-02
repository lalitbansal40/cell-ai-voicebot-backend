/**
 * DEV ONLY — realtime fan-out (Phase 16, T16.8).
 *   npm run perf:ws                    (1,000 connections, 100 events / s for 60 s)
 *   npm run perf:ws -- 200 20 30
 * Real tickets and sockets; events go through the Redis channel the API listens to. Target:
 * delivery p95 < 500 ms, and connections drop back to 0 after disconnect.
 */
import { performance } from 'node:perf_hooks';

import { Types } from 'mongoose';
import { WebSocket } from 'ws';

import { getEnv } from '../src/config/env';
import { metaAppSecret, signWebhook } from '../src/core/meta';
import { WsTicketService } from '../src/core/realtime/ws-tickets';

import { PERF_PORT, percentile, report, seedWorld, sleep, startPerf } from './perf-common';

const TARGET_P95_MS = 500;
const PUBLISH_CHANNEL = 'ws:fanout';

const main = async () => {
  const connections = Number(process.argv[2] ?? 1_000);
  const rate = Number(process.argv[3] ?? 100);
  const seconds = Number(process.argv[4] ?? 60);
  const secret = metaAppSecret(getEnv());
  const run = await startPerf();
  try {
    // the per-user and per-account limits stay on: 5 sockets a user, 50 an account
    const PER_ACCOUNT = 50;
    const PER_USER = 5;
    const w = await seedWorld((b) => signWebhook(b, secret));
    const tickets = new WsTicketService(run.redis);
    const accounts = Array.from({ length: Math.ceil(connections / PER_ACCOUNT) }, () =>
      new Types.ObjectId().toString(),
    );
    void w;
    const latencies: number[] = [];
    let received = 0;
    const sockets: WebSocket[] = [];
    const startConnect = performance.now();
    for (let i = 0; i < connections; i += 1) {
      const { ticket } = await tickets.issue({
        userId: `perf-user-${String(Math.floor(i / PER_USER))}`,
        accountId: accounts[Math.floor(i / PER_ACCOUNT)] ?? '',
        channel: 'events',
      });
      const ws = new WebSocket(`ws://127.0.0.1:${String(PERF_PORT)}/ws/events?ticket=${ticket}`);
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; data?: { sentAt?: number } };
        if (msg.type !== 'perf.tick' || !msg.data?.sentAt) return;
        received += 1;
        latencies.push(Date.now() - msg.data.sentAt);
      });
      ws.on('error', () => undefined);
      sockets.push(ws);
      await new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
        ws.once('error', () => resolve());
      });
    }
    const open = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
    console.info(
      `${String(open)} / ${String(connections)} connected in ${((performance.now() - startConnect) / 1000).toFixed(1)} s`,
    );
    const total = rate * seconds;
    const start = performance.now();
    for (let i = 0; i < total; i += 1) {
      const wait = start + (i / rate) * 1000 - performance.now();
      if (wait > 1) await sleep(wait);
      await run.redis.publish(
        PUBLISH_CHANNEL,
        JSON.stringify({
          target: { accountId: accounts[i % accounts.length] },
          event: {
            id: `evt_${String(i)}`,
            type: 'perf.tick',
            ts: new Date().toISOString(),
            data: { sentAt: Date.now() },
          },
        }),
      );
    }
    await sleep(2_000);
    // each event reaches one account's sockets
    const expected = Array.from({ length: total }, (_v, i) =>
      Math.min(PER_ACCOUNT, connections - (i % accounts.length) * PER_ACCOUNT),
    ).reduce((n, c) => n + c, 0);
    const p95 = percentile(latencies, 95);
    console.info(
      `Delivered ${String(received)} / ${String(expected)}; p50 ${String(percentile(latencies, 50))} ms, p95 ${String(p95)} ms (target < ${String(TARGET_P95_MS)})`,
    );
    for (const s of sockets) s.close();
    await sleep(3_000);
    const left = sockets.filter((s) => s.readyState !== WebSocket.CLOSED).length;
    console.info(`Sockets still open after disconnect: ${String(left)}`);
    report(open === connections && received === expected && p95 < TARGET_P95_MS && left === 0);
  } finally {
    await run.stop();
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
