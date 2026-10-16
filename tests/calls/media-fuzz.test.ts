import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { CALL_LIMITS } from '../../src/config/limits';
import { WsTicketService } from '../../src/core/realtime/ws-tickets';
import {
  createMediaServer,
  MEDIA_CLOSE,
  type MediaServer,
} from '../../src/core/telephony/media-server';
import { createLogger } from '../../src/shared/logger';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const prefix = `${uniquePrefix('mediafuzz')}:`;
let redis: Redis;
let server: Server;
let media: MediaServer;
let tickets: WsTicketService;

/** Deterministic pseudo-random numbers (the fuzz input is the same every run). */
const rng = (seed: number) => () => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return seed / 2 ** 32;
};

beforeAll(async () => {
  redis = (await requireRedis()).client;
  tickets = new WsTicketService(redis, `${prefix}wst:`);
  server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  media = createMediaServer({
    server,
    tickets,
    logger,
    textInput: true,
    attach: () => Promise.resolve({ ok: true }),
  });
});
afterAll(async () => {
  await media.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

const url = (ticket: string) =>
  `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/ws/media?ticket=${ticket}`;

const connect = (ticket: string) => {
  const ws = new WebSocket(url(ticket));
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary)
      messages.push(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>);
  });
  ws.on('error', () => undefined);
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  const opened = new Promise<void>((r) => ws.once('open', () => r()));
  return { ws, messages, closed, opened };
};

const newTicket = async (callId: string) =>
  (await tickets.issue({ userId: 'u1', accountId: 'a1', channel: 'media', callId })).ticket;

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe('/ws/media fuzz', () => {
  it('a ticket works once: reusing it is refused (4001)', async () => {
    const ticket = await newTicket('c-reuse');
    const first = connect(ticket);
    await until(() => first.messages.length > 0);
    expect(await connect(ticket).closed).toBe(MEDIA_CLOSE.unauthorized);
    first.ws.close();
  });

  it('random control garbage only gets error replies; the socket stays usable', async () => {
    const c = connect(await newTicket('c-garbage'));
    await until(() => c.messages.length > 0);
    const next = rng(42);
    const garbage = [
      'not json',
      '{',
      'null',
      '[]',
      '{"type":"call.dtmf","digit":"12"}',
      '{"type":"call.dtmf","digit":"a"}',
      '{"type":"call.ready","sampleRate":8000}',
      '{"type":"call.transfer_result","result":"maybe"}',
      '{"type":"call.mute","muted":"yes"}',
      '{"type":"call.say_text","text":""}',
      '{"type":"__proto__"}',
      JSON.stringify({ type: 'call.say_text', text: 'x'.repeat(CALL_LIMITS.sayTextMaxChars + 1) }),
    ];
    for (let i = 0; i < 40; i += 1) {
      garbage.push(
        JSON.stringify({ type: `t${String(Math.floor(next() * 1e6))}`, v: next(), n: [next()] }),
      );
    }
    for (const g of garbage) c.ws.send(g);
    await until(() => c.messages.filter((m) => m.type === 'error').length === garbage.length);
    expect(
      c.messages.filter((m) => m.type === 'error').every((m) => m.code === 'bad_message'),
    ).toBe(true);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.send(JSON.stringify({ type: 'call.dtmf', digit: '5' })); // valid ones still work
    c.ws.close();
  });

  it('any binary frame that is not exactly 960 bytes closes the socket (4008); oversized control closes 1009', async () => {
    const next = rng(7);
    for (let i = 0; i < 8; i += 1) {
      let size = 1 + Math.floor(next() * 4000);
      if (size === CALL_LIMITS.webFrameBytes) size += 1;
      const c = connect(await newTicket(`c-size-${String(i)}`));
      await until(() => c.messages.length > 0);
      c.ws.send(Buffer.alloc(size, 7));
      expect(await c.closed).toBe(MEDIA_CLOSE.policy);
    }
    const big = connect(await newTicket('c-big'));
    await until(() => big.messages.length > 0);
    big.ws.send('x'.repeat(CALL_LIMITS.controlMaxBytes + 10));
    expect(await big.closed).toBe(1009);
  });
});
