import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import type { Logger } from '../../shared/logger';

import { createEnvelope, type WsEventEnvelope } from './events';
import { defaultAuthorizeTopic, parseTopic, type AuthorizeTopic } from './topics';
import { WsTicketService } from './ws-tickets';

export const WS_EVENTS_PATH = '/ws/events';

/** Messages buffered per socket while its ticket is being verified. */
const MAX_PENDING_MESSAGES = 20;

/** Close codes (docs/conventions/websocket.md §7). */
export const WS_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  unauthorized: 4001,
  forbidden: 4003,
  policy: 4008,
  tooManyConnections: 4009,
  ticketExpired: 4010,
} as const;

export interface WsLimits {
  perUser: number;
  perAccount: number;
  messagesPerSecond: number;
  maxTopics: number;
  maxPayloadBytes: number;
  heartbeatMs: number;
  idleMs: number;
}

export const DEFAULT_WS_LIMITS: WsLimits = {
  perUser: 5,
  perAccount: 50,
  messagesPerSecond: 20,
  maxTopics: 20,
  maxPayloadBytes: 64 * 1024,
  heartbeatMs: 30_000,
  idleMs: 60_000,
};

export interface RealtimeDeps {
  server: Server;
  /** Shared command connection: tickets + publish. */
  redis: Redis;
  /** Dedicated subscriber connection for the fan-out channel. */
  subscriber: Redis;
  logger: Logger;
  limits?: Partial<WsLimits>;
  authorizeTopic?: AuthorizeTopic;
  /** Redis channel for cross-instance fan-out (tests use a unique one). */
  channel?: string;
  /** Ticket key prefix (tests use a unique one). */
  ticketPrefix?: string;
}

export interface Realtime {
  tickets: WsTicketService;
  pushToAccount: <T>(accountId: string, type: string, data: T) => Promise<WsEventEnvelope<T>>;
  pushToTopic: <T>(topic: string, type: string, data: T) => Promise<WsEventEnvelope<T>>;
  /**
   * One user's sockets (all instances). `close: true` closes them with 4001
   * after delivering the event (session revoked / user disabled).
   */
  pushToUser: <T>(
    accountId: string,
    userId: string,
    type: string,
    data: T,
    options?: { close?: boolean },
  ) => Promise<WsEventEnvelope<T>>;
  connectionCount: () => number;
  close: () => Promise<void>;
}

interface Client {
  ws: WebSocket;
  accountId: string;
  userId: string;
  topics: Set<string>;
  /** Last application message (ping / subscribe / …) — drives the idle timeout. */
  lastSeen: number;
  /** TCP liveness: false after a ws ping until the pong arrives. */
  isAlive: boolean;
  recent: number[];
}

type FanoutTarget =
  | { accountId: string; userId?: undefined }
  | { accountId: string; userId: string; close?: boolean }
  | { topic: string };
type FanoutMessage = { target: FanoutTarget; event: WsEventEnvelope };

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe'), topics: z.array(z.string()).max(50) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(z.string()).max(50) }),
]);

/** `ws` delivers Buffer | ArrayBuffer | Buffer[] depending on framing. */
const rawToString = (raw: RawData): string => {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
};

const send = (ws: WebSocket, payload: unknown): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

/**
 * `/ws/events` server: single-use ticket auth, per-account delivery, topics,
 * limits, heartbeat and Redis pub/sub fan-out across API instances.
 */
export const createRealtime = async (deps: RealtimeDeps): Promise<Realtime> => {
  const limits = { ...DEFAULT_WS_LIMITS, ...deps.limits };
  const channel = deps.channel ?? 'ws:fanout';
  const authorizeTopic = deps.authorizeTopic ?? defaultAuthorizeTopic;
  const tickets = new WsTicketService(deps.redis, deps.ticketPrefix);
  const log = deps.logger.child({ component: 'ws' });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes });
  const byAccount = new Map<string, Set<Client>>();

  const all = (): Client[] => [...byAccount.values()].flatMap((set) => [...set]);

  const register = (client: Client): void => {
    let set = byAccount.get(client.accountId);
    if (!set) {
      set = new Set();
      byAccount.set(client.accountId, set);
    }
    set.add(client);
  };

  const unregister = (client: Client): void => {
    const set = byAccount.get(client.accountId);
    set?.delete(client);
    if (set?.size === 0) byAccount.delete(client.accountId);
  };

  const deliver = (msg: FanoutMessage): void => {
    if ('accountId' in msg.target) {
      const { userId } = msg.target;
      const close = 'close' in msg.target && msg.target.close === true;
      for (const client of byAccount.get(msg.target.accountId) ?? []) {
        if (userId !== undefined && client.userId !== userId) continue;
        send(client.ws, msg.event);
        if (close) client.ws.close(WS_CLOSE.unauthorized, 'session revoked');
      }
      return;
    }
    const { topic } = msg.target;
    for (const client of all()) if (client.topics.has(topic)) send(client.ws, msg.event);
  };

  const onClientMessage = async (client: Client, raw: RawData): Promise<void> => {
    client.lastSeen = Date.now();
    const now = Date.now();
    client.recent = client.recent.filter((t) => now - t < 1000);
    client.recent.push(now);
    if (client.recent.length > limits.messagesPerSecond) {
      client.ws.close(WS_CLOSE.policy, 'rate limit');
      return;
    }

    let parsed: z.infer<typeof ClientMessageSchema>;
    try {
      parsed = ClientMessageSchema.parse(JSON.parse(rawToString(raw)));
    } catch {
      log.warn({ accountId: client.accountId }, 'ws: invalid client message ignored');
      return;
    }

    if (parsed.type === 'ping') {
      send(client.ws, { type: 'pong' });
      return;
    }
    if (parsed.type === 'unsubscribe') {
      for (const t of parsed.topics) client.topics.delete(t.toLowerCase());
      return;
    }
    for (const t of parsed.topics) {
      const topic = parseTopic(t);
      if (!topic || client.topics.size >= limits.maxTopics) {
        log.warn({ accountId: client.accountId, topic: t }, 'ws: topic rejected');
        continue;
      }
      if (!(await authorizeTopic({ accountId: client.accountId, userId: client.userId }, topic))) {
        log.warn({ accountId: client.accountId, topic: t }, 'ws: unauthorised topic ignored');
        continue;
      }
      client.topics.add(`${topic.kind}:${topic.id}`);
    }
  };

  /**
   * `pending` holds messages that arrived while the ticket was being checked
   * (Redis round-trip) — replayed once the client is registered, so an
   * immediate ping/subscribe after `open` is never lost.
   */
  const onConnection = async (
    ws: WebSocket,
    ticket: string | null,
    pending: RawData[],
    bufferListener: (raw: RawData) => void,
  ): Promise<void> => {
    const result = await tickets.consume(ticket);
    if (result.status !== 'ok') {
      ws.close(
        result.status === 'expired' ? WS_CLOSE.ticketExpired : WS_CLOSE.unauthorized,
        `ticket ${result.status}`,
      );
      return;
    }
    const { accountId, userId, channel: ticketChannel } = result.payload;
    if (ticketChannel !== 'events') {
      ws.close(WS_CLOSE.forbidden, 'wrong ticket channel');
      return;
    }
    const accountClients = byAccount.get(accountId) ?? new Set<Client>();
    const userCount = [...accountClients].filter((c) => c.userId === userId).length;
    if (accountClients.size >= limits.perAccount || userCount >= limits.perUser) {
      ws.close(WS_CLOSE.tooManyConnections, 'too many connections');
      return;
    }

    const client: Client = {
      ws,
      accountId,
      userId,
      topics: new Set(),
      lastSeen: Date.now(),
      isAlive: true,
      recent: [],
    };
    register(client);
    log.debug({ accountId, userId }, 'ws: connected');
    ws.off('message', bufferListener);
    ws.on('message', (raw) => void onClientMessage(client, raw));
    for (const raw of pending.splice(0)) void onClientMessage(client, raw);
    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('close', () => {
      unregister(client);
      log.debug({ accountId, userId }, 'ws: disconnected');
    });
    ws.on('error', (err) => log.warn({ err, accountId }, 'ws: socket error'));
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_EVENTS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const pending: RawData[] = [];
      const bufferListener = (raw: RawData): void => {
        if (pending.length < MAX_PENDING_MESSAGES) pending.push(raw);
      };
      ws.on('message', bufferListener);
      void onConnection(ws, url.searchParams.get('ticket'), pending, bufferListener);
    });
  };
  deps.server.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of all()) {
      if (!client.isAlive) {
        client.ws.terminate(); // no pong since the last ping — dead TCP connection
        continue;
      }
      if (now - client.lastSeen > limits.idleMs) {
        client.ws.close(WS_CLOSE.policy, 'idle timeout'); // no application message (client pings every 25 s)
        continue;
      }
      if (client.ws.readyState === WebSocket.OPEN) {
        client.isAlive = false;
        client.ws.ping();
      }
    }
  }, limits.heartbeatMs);
  heartbeat.unref();

  await deps.subscriber.subscribe(channel);
  const onFanout = (ch: string, message: string): void => {
    if (ch !== channel) return;
    try {
      deliver(JSON.parse(message) as FanoutMessage);
    } catch (err) {
      log.error({ err }, 'ws: bad fan-out message');
    }
  };
  deps.subscriber.on('message', onFanout);

  const publish = async <T>(
    target: FanoutMessage['target'],
    type: string,
    data: T,
  ): Promise<WsEventEnvelope<T>> => {
    const event = createEnvelope(type, data);
    await deps.redis.publish(channel, JSON.stringify({ target, event }));
    return event;
  };

  return {
    tickets,
    pushToAccount: (accountId, type, data) => publish({ accountId }, type, data),
    pushToTopic: (topic, type, data) => publish({ topic: topic.toLowerCase() }, type, data),
    pushToUser: (accountId, userId, type, data, options = {}) =>
      publish({ accountId, userId, ...(options.close ? { close: true } : {}) }, type, data),
    connectionCount: () => all().length,
    close: async () => {
      clearInterval(heartbeat);
      deps.server.off('upgrade', onUpgrade);
      deps.subscriber.off('message', onFanout);
      for (const client of all()) client.ws.close(WS_CLOSE.goingAway, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await deps.subscriber.unsubscribe(channel).catch(() => undefined);
    },
  };
};
