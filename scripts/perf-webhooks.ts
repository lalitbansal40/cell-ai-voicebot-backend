/**
 * DEV ONLY — Phase 15 webhook throughput check (PHASE_15_PROMPT T15.9 §3).
 *   npm run perf:webhooks              (1,000 events / min × 5 endpoints for 5 min)
 *   npm run perf:webhooks -- 1 200     (1 minute at 200 events / min)
 * Throw-away database `cav_perf` on the MONGODB_URI server (dropped at the end), its own
 * BullMQ prefix, 5 local receivers on 127.0.0.1. Measures event → receipt latency
 * (p50 / p95, target p95 < 5 s), lost and duplicate deliveries and that the queue
 * drains. Needs `npm run infra:up`. Refuses NODE_ENV=production.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import mongoose, { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { closeAllQueues } from '../src/core/queues/queue-factory';
import { startWebhooksWorker } from '../src/core/queues/workers/webhooks.worker';
import { AccountModel } from '../src/db/models/account.model';
import { WebhookDeliveryModel } from '../src/db/models/webhook-delivery.model';
import { WebhookEndpointModel } from '../src/db/models/webhook-endpoint.model';
import { WebhookEventModel } from '../src/db/models/webhook-event.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { webhookRuntime } from '../src/modules/webhooks/deliver.job';
import { emitAccountEvent } from '../src/modules/webhooks/events';
import { queueWebhookJobs, setWebhookJobs } from '../src/modules/webhooks/jobs';
import { newWebhookSecret, verify } from '../src/modules/webhooks/signing';
import { seal, secretBoxKey } from '../src/shared/crypto/secret-box';
import { createLogger } from '../src/shared/logger';

import { perfUri } from './perf-reports';

const ENDPOINTS = 5;
const TARGET_P95_MS = 5_000;
const DRAIN_TIMEOUT_MS = 120_000;

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Receiver {
  server: Server;
  url: string;
  /** event id → receipts (duplicates show as > 1) */
  seen: Map<string, number>;
  latencies: number[];
  badSignatures: number;
}

const startReceiver = async (secret: string): Promise<Receiver> => {
  const r = { seen: new Map<string, number>(), latencies: [] as number[], badSignatures: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ok = verify(
        req.headers['x-webhook-signature'] as string | undefined,
        [secret],
        req.headers['x-webhook-timestamp'] as string | undefined,
        raw,
      );
      if (!ok) r.badSignatures += 1;
      const body = JSON.parse(raw.toString('utf8')) as { id: string; createdAt: string };
      r.seen.set(body.id, (r.seen.get(body.id) ?? 0) + 1);
      r.latencies.push(Date.now() - new Date(body.createdAt).getTime());
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { ...r, server, url: `http://127.0.0.1:${String(port)}/hook` };
};

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('perf:webhooks refuses NODE_ENV=production');
  const minutes = Number(process.argv[2] ?? 5);
  const perMinute = Number(process.argv[3] ?? 1_000);
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  await connectMongo({ ...env, MONGODB_URI: perfUri(env.MONGODB_URI) }, logger);
  const prefix = `cav_perf_${String(Date.now())}`;
  const receivers: Receiver[] = [];
  try {
    await mongoose.connection.dropDatabase();
    await Promise.all([
      WebhookEventModel.createIndexes(),
      WebhookDeliveryModel.createIndexes(),
      WebhookEndpointModel.createIndexes(),
    ]);
    const account = await AccountModel.create({ name: 'Perf webhooks', slug: `perf-${prefix}` });
    const key = secretBoxKey(env);
    for (let i = 0; i < ENDPOINTS; i += 1) {
      const secret = newWebhookSecret();
      const receiver = await startReceiver(secret);
      receivers.push(receiver);
      await WebhookEndpointModel.create({
        accountId: account._id,
        url: receiver.url,
        events: ['*'],
        secretSealed: seal(key, secret),
      });
    }

    const { queue } = startWebhooksWorker({
      redisUrl: env.REDIS_URL,
      logger,
      prefix,
      runtime: webhookRuntime({ ...env, AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: true }),
    });
    setWebhookJobs(queueWebhookJobs(queue));

    const total = minutes * perMinute;
    const gapMs = 60_000 / perMinute;
    console.info(
      `Emitting ${String(total)} events (${String(perMinute)} / min for ${String(minutes)} min) to ${String(ENDPOINTS)} endpoints…`,
    );
    const start = performance.now();
    const emitted: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const due = start + i * gapMs;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      const id = await emitAccountEvent(account._id, 'call.completed', {
        callId: new Types.ObjectId().toString(),
        status: 'completed',
        durationSec: i % 300,
      });
      if (id) emitted.push(id);
    }
    const emitSec = (performance.now() - start) / 1000;

    const expected = emitted.length * ENDPOINTS;
    const received = () => receivers.reduce((n, r) => n + r.seen.size, 0);
    const drainStart = performance.now();
    while (received() < expected && performance.now() - drainStart < DRAIN_TIMEOUT_MS) {
      await sleep(500);
    }
    const jobCounts = await queue.getJobCounts('waiting', 'active', 'delayed');
    const counts = {
      waiting: jobCounts.waiting ?? 0,
      active: jobCounts.active ?? 0,
      delayed: jobCounts.delayed ?? 0,
    };
    const latencies = receivers.flatMap((r) => r.latencies);
    const lost = emitted.length * ENDPOINTS - received();
    const duplicates = receivers.reduce(
      (n, r) => n + [...r.seen.values()].reduce((d, c) => d + (c - 1), 0),
      0,
    );
    const bad = receivers.reduce((n, r) => n + r.badSignatures, 0);
    const p95 = percentile(latencies, 95);
    console.info(`Emit: ${emitSec.toFixed(1)} s for ${String(emitted.length)} events`);
    console.info(
      `Deliveries: ${String(received())} / ${String(expected)} received, lost ${String(lost)}, duplicates ${String(duplicates)}, bad signatures ${String(bad)}`,
    );
    console.info(
      `Latency event → receipt: p50 ${String(percentile(latencies, 50))} ms, p95 ${String(p95)} ms, max ${String(Math.max(0, ...latencies))} ms (target p95 < ${String(TARGET_P95_MS)} ms)`,
    );
    console.info(
      `Queue after drain: waiting ${String(counts.waiting)}, active ${String(counts.active)}, delayed ${String(counts.delayed)}`,
    );
    const pass =
      p95 < TARGET_P95_MS &&
      lost === 0 &&
      duplicates === 0 &&
      bad === 0 &&
      counts.waiting + counts.active + counts.delayed === 0;
    console.info(pass ? 'PASS' : 'FAIL');
    await queue.obliterate({ force: true });
    if (!pass) process.exitCode = 1;
  } finally {
    await closeAllQueues();
    for (const r of receivers) r.server.close();
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
