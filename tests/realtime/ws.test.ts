import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { closeAllRedis, createRedis } from '../../src/core/queues/redis';
import { createRealtime, WS_CLOSE, type Realtime, type WsLimits } from '../../src/core/realtime';
import { createLogger } from '../../src/shared/logger';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const ACCOUNT_A = 'acc-a';
const ACCOUNT_B = 'acc-b';
const CAMPAIGN = 'campaign:66f1c2a9e4b0c1d2e3f4a5b6';

interface Instance {
  server: Server;
  realtime: Realtime;
  url: string;
}

interface TestClient {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  next: (predicate?: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

let redisUrl: string;
let cleanupClient: Redis;
const ticketPrefix = `${uniquePrefix('wst')}:`;
const channel = uniquePrefix('fanout');
const instances: Instance[] = [];
const clients: WebSocket[] = [];

const startInstance = async (limits: Partial<WsLimits> = {}): Promise<Instance> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const realtime = await createRealtime({
    server,
    redis: createRedis(redisUrl, 'ws-test', logger),
    subscriber: createRedis(redisUrl, 'ws-test-sub', logger),
    logger,
    limits,
    channel,
    ticketPrefix,
  });
  const instance = {
    server,
    realtime,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
  instances.push(instance);
  return instance;
};

const connect = (url: string): TestClient => {
  const ws = new WebSocket(url);
  clients.push(ws);
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>;
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  ws.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const next = (predicate: (m: Record<string, unknown>) => boolean = () => true) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const found = messages.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      waiters.push({ predicate, resolve });
      setTimeout(() => reject(new Error('timed out waiting for message')), 2000).unref();
    });
  return { ws, messages, closed, next };
};

const opened = (c: TestClient) =>
  new Promise<void>((resolve, reject) => {
    if (c.ws.readyState === WebSocket.OPEN) resolve();
    c.ws.once('open', () => resolve());
    c.ws.once('unexpected-response', () => reject(new Error('unexpected response')));
  });

const ticketUrl = async (
  instance: Instance,
  accountId = ACCOUNT_A,
  userId = 'user-1',
  ch: 'events' | 'media' = 'events',
) => {
  const { ticket } = await instance.realtime.tickets.issue({ accountId, userId, channel: ch });
  return { url: `${instance.url}/ws/events?ticket=${ticket}`, ticket };
};

/** Waits until the server registered the connection (ticket consumed asynchronously). */
const ready = async (instance: Instance, count: number) => {
  for (let i = 0; i < 100 && instance.realtime.connectionCount() < count; i += 1)
    await new Promise((r) => setTimeout(r, 10));
};

beforeAll(async () => {
  const r = await requireRedis();
  redisUrl = r.url;
  cleanupClient = r.client;
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const inst of instances.splice(0)) {
    await inst.realtime.close();
    await new Promise<void>((resolve) => inst.server.close(() => resolve()));
  }
});

afterAll(async () => {
  await closeAllRedis();
  await flushPrefix(cleanupClient, ticketPrefix);
  cleanupClient.disconnect();
});

describe('/ws/events authentication', () => {
  it('accepts a valid ticket and delivers account events in the envelope', async () => {
    const inst = await startInstance();
    const c = connect((await ticketUrl(inst)).url);
    await opened(c);
    await ready(inst, 1);
    await inst.realtime.pushToAccount(ACCOUNT_A, 'wallet.updated', {
      balanceMicros: 1,
      holdMicros: 0,
      currency: 'INR',
    });
    const msg = await c.next((m) => m.type === 'wallet.updated');
    expect(msg.id).toMatch(/^evt_/);
    expect(typeof msg.ts).toBe('string');
    expect(msg.data).toEqual({ balanceMicros: 1, holdMicros: 0, currency: 'INR' });
  });

  it('rejects a reused ticket with 4001', async () => {
    const inst = await startInstance();
    const { url } = await ticketUrl(inst);
    const first = connect(url);
    await opened(first);
    await ready(inst, 1);
    const second = connect(url);
    expect((await second.closed).code).toBe(WS_CLOSE.unauthorized);
  });

  it('rejects unknown and missing tickets with 4001', async () => {
    const inst = await startInstance();
    expect((await connect(`${inst.url}/ws/events?ticket=wst_${'x'.repeat(40)}`).closed).code).toBe(
      WS_CLOSE.unauthorized,
    );
    expect((await connect(`${inst.url}/ws/events`).closed).code).toBe(WS_CLOSE.unauthorized);
  });

  it('rejects an expired ticket with 4010', async () => {
    const inst = await startInstance();
    const ticket = `wst_${'e'.repeat(43)}`;
    await cleanupClient.set(
      `${ticketPrefix}${ticket}`,
      JSON.stringify({
        accountId: ACCOUNT_A,
        userId: 'u',
        channel: 'events',
        exp: Date.now() - 1000,
      }),
      'EX',
      60,
    );
    expect((await connect(`${inst.url}/ws/events?ticket=${ticket}`).closed).code).toBe(
      WS_CLOSE.ticketExpired,
    );
  });

  it('rejects a media ticket on the events endpoint with 4003', async () => {
    const inst = await startInstance();
    const { url } = await ticketUrl(inst, ACCOUNT_A, 'u', 'media');
    expect((await connect(url).closed).code).toBe(WS_CLOSE.forbidden);
  });

  it('refuses upgrades on other paths', async () => {
    const inst = await startInstance();
    const c = connect(`${inst.url}/ws/other`);
    const result = await Promise.race([
      c.closed.then(() => 'closed'),
      opened(c).then(
        () => 'open',
        () => 'refused',
      ),
    ]);
    expect(result).not.toBe('open');
  });
});

describe('/ws/events delivery', () => {
  it('isolates accounts', async () => {
    const inst = await startInstance();
    const a = connect((await ticketUrl(inst, ACCOUNT_A)).url);
    const b = connect((await ticketUrl(inst, ACCOUNT_B, 'user-b')).url);
    await Promise.all([opened(a), opened(b)]);
    await ready(inst, 2);
    await inst.realtime.pushToAccount(ACCOUNT_A, 'notification.created', {
      notificationId: 'n1',
      title: 't',
    });
    await a.next((m) => m.type === 'notification.created');
    await new Promise((r) => setTimeout(r, 100));
    expect(b.messages.filter((m) => m.type === 'notification.created')).toHaveLength(0);
  });

  it('delivers topic events only to subscribers, and stops after unsubscribe', async () => {
    const inst = await startInstance();
    const sub = connect((await ticketUrl(inst)).url);
    const other = connect((await ticketUrl(inst, ACCOUNT_A, 'user-2')).url);
    await Promise.all([opened(sub), opened(other)]);
    await ready(inst, 2);
    sub.ws.send(JSON.stringify({ type: 'subscribe', topics: [CAMPAIGN, 'not-a-topic'] }));
    sub.ws.send(JSON.stringify({ type: 'ping' }));
    await sub.next((m) => m.type === 'pong');
    await inst.realtime.pushToTopic(CAMPAIGN, 'campaign.progress', {
      campaignId: 'c',
      stats: { queued: 1 },
    });
    await sub.next((m) => m.type === 'campaign.progress');
    sub.ws.send(JSON.stringify({ type: 'unsubscribe', topics: [CAMPAIGN] }));
    sub.ws.send(JSON.stringify({ type: 'ping' }));
    await new Promise((r) => setTimeout(r, 100));
    const before = sub.messages.filter((m) => m.type === 'campaign.progress').length;
    await inst.realtime.pushToTopic(CAMPAIGN, 'campaign.progress', {
      campaignId: 'c',
      stats: { queued: 2 },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(sub.messages.filter((m) => m.type === 'campaign.progress')).toHaveLength(before);
    expect(other.messages.filter((m) => m.type === 'campaign.progress')).toHaveLength(0);
  });

  it('answers ping with pong and ignores invalid JSON', async () => {
    const inst = await startInstance();
    const c = connect((await ticketUrl(inst)).url);
    await opened(c);
    await ready(inst, 1);
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await c.next((m) => m.type === 'pong')).type).toBe('pong');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('does not lose messages sent immediately after open (before the ticket check finishes)', async () => {
    const inst = await startInstance();
    const c = connect((await ticketUrl(inst)).url);
    c.ws.once('open', () => {
      c.ws.send(JSON.stringify({ type: 'ping' }));
      c.ws.send(JSON.stringify({ type: 'subscribe', topics: [CAMPAIGN] }));
    });
    await c.next((m) => m.type === 'pong');
    await ready(inst, 1);
    await inst.realtime.pushToTopic(CAMPAIGN, 'campaign.status', {
      campaignId: 'c',
      status: 'running',
    });
    expect((await c.next((m) => m.type === 'campaign.status')).data).toEqual({
      campaignId: 'c',
      status: 'running',
    });
  });

  it('fans out across two server instances through Redis', async () => {
    const one = await startInstance();
    const two = await startInstance();
    const c = connect((await ticketUrl(two)).url);
    await opened(c);
    await ready(two, 1);
    await one.realtime.pushToAccount(ACCOUNT_A, 'call.status', { callId: 'x', status: 'ringing' });
    expect((await c.next((m) => m.type === 'call.status')).data).toEqual({
      callId: 'x',
      status: 'ringing',
    });
  });
});

describe('/ws/events limits & lifecycle', () => {
  it('limits connections per user (4009)', async () => {
    const inst = await startInstance({ perUser: 1 });
    const first = connect((await ticketUrl(inst)).url);
    await opened(first);
    await ready(inst, 1);
    const second = connect((await ticketUrl(inst)).url);
    expect((await second.closed).code).toBe(WS_CLOSE.tooManyConnections);
  });

  it('closes on oversized messages (1009)', async () => {
    const inst = await startInstance({ maxPayloadBytes: 1024 });
    const c = connect((await ticketUrl(inst)).url);
    await opened(c);
    await ready(inst, 1);
    c.ws.send('x'.repeat(4096));
    expect((await c.closed).code).toBe(1009);
  });

  it('closes clients that flood messages (4008)', async () => {
    const inst = await startInstance({ messagesPerSecond: 3 });
    const c = connect((await ticketUrl(inst)).url);
    await opened(c);
    await ready(inst, 1);
    for (let i = 0; i < 6; i += 1) c.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await c.closed).code).toBe(WS_CLOSE.policy);
  });

  it('closes idle clients (4008)', async () => {
    const inst = await startInstance({ heartbeatMs: 30, idleMs: 60 });
    const c = connect((await ticketUrl(inst)).url);
    await opened(c);
    expect((await c.closed).code).toBe(WS_CLOSE.policy);
  });

  it('close() sends 1001 to connected clients', async () => {
    const inst = await startInstance();
    const c = connect((await ticketUrl(inst)).url);
    await opened(c);
    await ready(inst, 1);
    await inst.realtime.close();
    expect((await c.closed).code).toBe(WS_CLOSE.goingAway);
  });
});
