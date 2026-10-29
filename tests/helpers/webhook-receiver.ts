import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll } from 'vitest';

import type { WebhookHooks } from '../../src/modules/webhooks/deliver.job';

export interface ReceivedWebhook {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
}

export interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Never answers (timeout tests). */
  hang?: boolean;
}

/** A public-looking host the fake resolver maps to the local receiver (no network in tests). */
export const RECEIVER_HOST = 'hooks.example.com';
export const PUBLIC_IP = '93.184.216.34';

/**
 * A local HTTP receiver on 127.0.0.1 + the runtime hooks that send `hooks.example.com`
 * there: the URL guard still sees a public address (resolver), the dial goes local.
 */
export const useWebhookReceiver = () => {
  const received: ReceivedWebhook[] = [];
  const state = { reply: { status: 200, body: 'ok' } as Reply | ((r: ReceivedWebhook) => Reply) };
  const hanging = new Set<() => void>();
  let server: Server;
  const r = {
    received,
    port: 0,
    url: (path = '/hook') => `http://${RECEIVER_HOST}:${String(r.port)}${path}`,
    reply: (reply: Reply | ((x: ReceivedWebhook) => Reply)) => {
      state.reply = reply;
    },
    reset: () => {
      received.length = 0;
      state.reply = { status: 200, body: 'ok' };
    },
    hooks: {
      resolve: (host: string) =>
        Promise.resolve(host === RECEIVER_HOST ? [PUBLIC_IP] : ['203.0.113.10']),
      dial: (address: string) => (address === PUBLIC_IP ? '127.0.0.1' : address),
    } satisfies WebhookHooks,
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const got = {
          path: req.url ?? '',
          headers: req.headers,
          raw: Buffer.concat(chunks).toString('utf8'),
        };
        received.push(got);
        const reply = typeof state.reply === 'function' ? state.reply(got) : state.reply;
        if (reply.hang) {
          hanging.add(() => res.destroy());
          return;
        }
        res.writeHead(reply.status, { 'content-type': 'text/plain', ...reply.headers });
        res.end(reply.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    r.port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const stop of hanging) stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return r;
};
