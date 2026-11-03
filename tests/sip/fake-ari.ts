import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

/** One REST call the fake received (method, path without `/ari`, query). */
export interface AriCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: string | undefined;
}

export type AriReply = { status: number; body?: unknown } | undefined;
export type AriHandler = (call: AriCall) => AriReply | Promise<AriReply>;

/**
 * In-process Asterisk REST Interface: HTTP for REST, a WebSocket on `/ari/events`.
 * Tests script replies with `on()` and push events with `send()`.
 */
export class FakeAri {
  readonly calls: AriCall[] = [];
  private readonly sockets = new Set<WebSocket>();
  private handlers: AriHandler[] = [];
  private server!: Server;
  private wss!: WebSocketServer;
  url = '';
  /** Rejects event socket upgrades while true (ARI down). */
  refuse = false;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req).then((reply) => {
        const r = reply ?? { status: 200, body: {} };
        if (r.body === undefined) {
          res.writeHead(r.status).end();
          return;
        }
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (this.refuse || !req.url?.startsWith('/ari/events')) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  private async handle(req: IncomingMessage): Promise<AriReply> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    const call: AriCall = {
      method: req.method ?? 'GET',
      path: url.pathname.replace(/^\/ari/, ''),
      query: Object.fromEntries(url.searchParams),
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
      auth: req.headers.authorization,
    };
    this.calls.push(call);
    for (const handler of this.handlers) {
      const reply = await handler(call);
      if (reply) return reply;
    }
    return undefined;
  }

  on(handler: AriHandler): void {
    this.handlers.push(handler);
  }

  get clients(): number {
    return this.sockets.size;
  }

  send(event: Record<string, unknown>): void {
    const text = JSON.stringify(event);
    for (const ws of this.sockets) ws.send(text);
  }

  /** Drops every event socket (Asterisk restart / network blip). */
  dropSockets(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  callsTo(method: string, prefix: string): AriCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  }

  async stop(): Promise<void> {
    this.dropSockets();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Waits until `check()` is true (real timers; short polling). */
export const waitFor = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
