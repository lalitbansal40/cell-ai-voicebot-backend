import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { getEmail, MemoryEmailProvider } from '../../src/core/email';
import { getRealtime, WsTicketService } from '../../src/core/realtime';
import { startServer, type RunningServer } from '../../src/server';
import { createLogger } from '../../src/shared/logger';
import { startTestMongo } from '../helpers/mongo';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

/**
 * Full server, as `npm run dev` starts it (Mongo + Redis + workers + realtime
 * + email), on a random port — then a real graceful shutdown.
 */
describe('startServer (e2e)', () => {
  const prefix = uniquePrefix('e2e');
  const accountId = `acc_${randomBytes(4).toString('hex')}`;
  const email = new MemoryEmailProvider();
  const logLines: Record<string, unknown>[] = [];
  const exitCodes: number[] = [];
  let running: RunningServer;
  let base: string;
  let stopMongo: () => Promise<void>;
  let cleanupRedis: () => Promise<void>;
  let tickets: WsTicketService;

  beforeAll(async () => {
    const mongo = await startTestMongo();
    stopMongo = mongo.stop;
    const redis = await requireRedis();
    tickets = new WsTicketService(redis.client); // same `wst:` keys the server reads
    cleanupRedis = async () => {
      await flushPrefix(redis.client, prefix);
      redis.client.disconnect();
    };
    const env = testEnv({
      MONGODB_URI: mongo.uri,
      REDIS_URL: redis.url,
      WORKERS_ENABLED: 'true',
      EMAIL_DRIVER: 'log',
      LOG_LEVEL: 'info',
    });
    const logger = createLogger(
      env,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          logLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          cb();
        },
      }),
    );
    running = await startServer({
      env,
      logger,
      port: 0,
      installSignalHandlers: false,
      queuePrefix: prefix,
      emailProvider: email,
      exit: (code) => exitCodes.push(code),
    });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterAll(async () => {
    if (!running.lifecycle.isShuttingDown()) await running.lifecycle.shutdown('test cleanup');
    await cleanupRedis();
    await stopMongo();
  });

  it('listens on a random port', () => {
    expect(running.port).toBeGreaterThan(0);
  });

  it('serves /health and /ready with real dependencies', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      success: true,
      data: { status: 'ready', checks: { mongo: 'up', redis: 'up' } },
    });
  });

  it('serves the API, the spec and the docs', async () => {
    const info = await fetch(`${base}/api/v1/system/info`);
    expect(info.status).toBe(200);
    expect(((await info.json()) as { data: { name: string } }).data.name).toBe(
      'cell-ai-voicebot-backend',
    );
    const spec = await fetch(`${base}/api/v1/openapi.json`);
    expect(((await spec.json()) as { openapi: string }).openapi).toBe('3.1.0');
    expect((await fetch(`${base}/api/docs`)).status).toBe(200);
  });

  it('returns the 404 envelope with the request id header', async () => {
    const res = await fetch(`${base}/api/v1/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('delivers a pushed event over /ws/events and rejects a reused ticket', async () => {
    const { ticket } = await tickets.issue({ userId: 'u1', accountId, channel: 'events' });
    const url = `ws://127.0.0.1:${running.port}/ws/events?ticket=${ticket}`;

    const ws = new WebSocket(url);
    const received = new Promise<{ type: string; data: unknown }>((resolve, reject) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf8')) as { type: string; data: unknown };
        if (msg.type === 'pong') {
          void getRealtime().pushToAccount(accountId, 'wallet.updated', { balanceMicros: 42 });
        } else resolve(msg);
      });
      ws.on('error', reject);
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await received).toMatchObject({ type: 'wallet.updated', data: { balanceMicros: 42 } });
    ws.close();

    const reused = new WebSocket(url);
    const code = await new Promise<number>((resolve) => reused.on('close', resolve));
    expect(code).toBe(4001);
  });

  it('sends a queued email through the email worker', async () => {
    await getEmail().enqueue('system.test', 'e2e@example.com', { name: 'E2E' });
    await expect.poll(() => email.sent.length, { timeout: 10_000 }).toBe(1);
    expect(email.sent[0]?.to).toBe('e2e@example.com');
  });

  it('shuts down gracefully in order and frees the port', async () => {
    await running.lifecycle.shutdown('e2e');
    const hooks = logLines
      .filter((l) => l.msg === 'shutdown: running hook')
      .map((l) => l.hook as string);
    expect(hooks).toEqual(['http', 'ws', 'queues', 'email', 'redis', 'mongo']);
    expect(logLines.some((l) => l.msg === 'shutdown: complete')).toBe(true);
    expect(exitCodes).toEqual([0]);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    expect(() => getEmail()).toThrow('Email service not initialised');
  });
});
