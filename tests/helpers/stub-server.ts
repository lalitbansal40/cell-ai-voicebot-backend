import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll } from 'vitest';

export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type StubHandler = (req: StubRequest, res: ServerResponse) => void | Promise<void>;

/**
 * Local HTTP stub on a random port (no network in tests). Queue handlers with
 * `next(...)`; without one the stub answers 500. Every request is recorded.
 */
export const useStubServer = () => {
  const requests: StubRequest[] = [];
  const queue: StubHandler[] = [];
  let fallback: StubHandler | null = null;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(request);
      const handler = queue.shift() ?? fallback;
      if (!handler) {
        res.writeHead(500).end();
        return;
      }
      void Promise.resolve(handler(request, res)).catch(() => res.destroy());
    });
  });
  const state = { url: '', port: 0 };
  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          state.port = (server.address() as AddressInfo).port;
          state.url = `http://127.0.0.1:${state.port}`;
          resolve();
        });
      }),
  );
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    requests,
    get url() {
      return state.url;
    },
    get port() {
      return state.port;
    },
    next(...handlers: StubHandler[]) {
      queue.push(...handlers);
    },
    always(handler: StubHandler | null) {
      fallback = handler;
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      fallback = null;
    },
  };
};

export const json =
  (status: number, payload: unknown, headers: Record<string, string> = {}): StubHandler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };
