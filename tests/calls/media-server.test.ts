import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ConsumeResult } from '../../src/core/realtime/ws-tickets';
import {
  createMediaServer,
  MEDIA_CLOSE,
  type AttachResult,
  type MediaServer,
} from '../../src/core/telephony/media-server';
import type { WebCallLeg } from '../../src/core/telephony/webcall';
import { createLogger } from '../../src/shared/logger';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const started: { server: Server; media: MediaServer }[] = [];
afterEach(async () => {
  for (const s of started.splice(0)) {
    await s.media.close();
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

type Ticket = { status: 'ok'; payload: Record<string, unknown> } | ConsumeResult;

const start = async (
  options: {
    tickets?: Record<string, Ticket>;
    textInput?: boolean;
    attach?: (leg: WebCallLeg) => AttachResult | Promise<AttachResult>;
  } = {},
) => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const legs: WebCallLeg[] = [];
  const tickets = options.tickets ?? {
    good: {
      status: 'ok',
      payload: { userId: 'u1', accountId: 'a1', channel: 'media', callId: 'c1', exp: 0 },
    },
  };
  const media = createMediaServer({
    server,
    logger,
    textInput: options.textInput ?? true,
    tickets: {
      consume: (t) =>
        Promise.resolve((t && tickets[t]) ?? { status: 'invalid' }) as Promise<ConsumeResult>,
    },
    attach: async (_input, leg) => {
      legs.push(leg);
      return options.attach ? options.attach(leg) : { ok: true };
    },
  });
  started.push({ server, media });
  const url = (ticket: string, path = '/ws/media') =>
    `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}${path}?ticket=${ticket}`;
  return { media, legs, url };
};

const open = (url: string) => {
  const ws = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) binary.push(data as Buffer);
    else messages.push(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>);
  });
  ws.on('close', (code, reason) => (closed = { code, reason: reason.toString() }));
  ws.on('error', () => undefined);
  return {
    ws,
    messages,
    binary,
    closed: () => closed,
    opened: new Promise<void>((r) => ws.once('open', () => r())),
    waitClosed: () =>
      new Promise<{ code: number; reason: string }>((r) => {
        if (closed) r(closed);
        else ws.once('close', (code, reason) => r({ code, reason: reason.toString() }));
      }),
  };
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe('/ws/media', () => {
  it('a valid media ticket attaches a leg, sends the config and routes audio + control', async () => {
    const { legs, url, media } = await start();
    const c = open(url('good'));
    await until(() => c.messages.length > 0);
    expect(c.messages[0]).toEqual({
      type: 'call.config',
      textInput: true,
      sampleRate: 24000,
      frameBytes: 960,
    });
    expect(media.connections()).toBe(1);
    const leg = legs[0] as WebCallLeg;
    const seen: string[] = [];
    leg.onAudio((f) => seen.push(`audio:${String(f.length)}`));
    leg.onDtmf((d) => seen.push(`dtmf:${d}`));
    leg.onText((t) => seen.push(`text:${t}`));
    leg.onStatus((s) => seen.push(`status:${s}`));
    c.ws.send(JSON.stringify({ type: 'call.ready', sampleRate: 24000 }));
    c.ws.send(Buffer.alloc(960));
    c.ws.send(JSON.stringify({ type: 'call.dtmf', digit: '#' }));
    c.ws.send(JSON.stringify({ type: 'call.say_text', text: '  kal tak  ' }));
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'call.dtmf', digit: '12' }));
    await until(() => c.messages.filter((m) => m.type === 'error').length === 2);
    expect(seen).toEqual(['status:answered', 'audio:480', 'dtmf:#', 'text:kal tak']);
    void leg.play(new Int16Array(480));
    await until(() => c.binary.length === 1);
    expect(c.binary[0]?.length).toBe(960);
    c.ws.close();
    await until(() => seen.includes('status:ended'));
    await until(() => media.connections() === 0);
  });

  it('refuses bad tickets, a second socket, refused attaches and text input when disabled', async () => {
    const { url } = await start({
      tickets: {
        good: {
          status: 'ok',
          payload: { userId: 'u', accountId: 'a', channel: 'media', callId: 'c1', exp: 0 },
        },
        events: {
          status: 'ok',
          payload: { userId: 'u', accountId: 'a', channel: 'events', exp: 0 },
        },
        nocall: {
          status: 'ok',
          payload: { userId: 'u', accountId: 'a', channel: 'media', exp: 0 },
        },
        old: { status: 'expired' },
      },
      textInput: false,
    });
    expect((await open(url('nope')).waitClosed()).code).toBe(MEDIA_CLOSE.unauthorized);
    expect((await open(url('old')).waitClosed()).code).toBe(MEDIA_CLOSE.ticketExpired);
    expect((await open(url('events')).waitClosed()).code).toBe(MEDIA_CLOSE.unauthorized);
    expect((await open(url('nocall')).waitClosed()).code).toBe(MEDIA_CLOSE.unauthorized);
    const first = open(url('good'));
    await until(() => first.messages.length > 0);
    expect(first.messages[0]).toMatchObject({ textInput: false });
    expect((await open(url('good')).waitClosed()).code).toBe(MEDIA_CLOSE.alreadyConnected);
    first.ws.send(JSON.stringify({ type: 'call.say_text', text: 'x' }));
    await until(() => first.messages.some((m) => m.code === 'text_input_disabled'));
    const refused = await start({
      attach: () => ({ ok: false, code: MEDIA_CLOSE.callEnded, reason: 'ended' }),
    });
    expect(await open(refused.url('good')).waitClosed()).toEqual({ code: 4012, reason: 'ended' });
    const broken = await start({ attach: () => Promise.reject(new Error('db down')) });
    expect((await open(broken.url('good')).waitClosed()).code).toBe(1011);
  });

  it('closes on a wrong frame size or a frame flood (4008); other paths are left alone', async () => {
    const { url } = await start();
    const c = open(url('good'));
    await until(() => c.messages.length > 0);
    c.ws.send(Buffer.alloc(959));
    expect((await c.waitClosed()).code).toBe(MEDIA_CLOSE.policy);
    const flood = await start();
    const f = open(flood.url('good'));
    await until(() => f.messages.length > 0);
    for (let i = 0; i < 150; i += 1) f.ws.send(Buffer.alloc(960));
    expect(await f.waitClosed()).toMatchObject({
      code: MEDIA_CLOSE.policy,
      reason: 'too many frames',
    });
  });

  it('messages sent before the ticket check are replayed; close() ends live sockets', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { legs, url, media } = await start({
      attach: async () => {
        await gate;
        return { ok: true };
      },
    });
    const c = open(url('good'));
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'call.ready', sampleRate: 24000 }));
    c.ws.send(Buffer.alloc(960));
    await new Promise((r) => setTimeout(r, 20));
    const seen: string[] = [];
    await until(() => legs.length === 1);
    legs[0]?.onStatus((s) => seen.push(s));
    legs[0]?.onAudio(() => seen.push('audio'));
    release();
    await until(() => seen.includes('audio'));
    expect(seen).toEqual(['ringing', 'answered', 'audio']);
    await media.close();
    expect((await c.waitClosed()).code).toBe(MEDIA_CLOSE.goingAway);
  });
});
