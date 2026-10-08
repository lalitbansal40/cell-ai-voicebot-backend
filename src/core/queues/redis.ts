import { Redis } from 'ioredis';

import type { Logger } from '../../shared/logger';

/** host:port only — never log passwords. */
export const redactRedisUrl = (url: string): string => {
  const match = /^(rediss?:\/\/)(?:[^@/]*@)?([^/?]+)/.exec(url);
  return match ? `${match[1]}${match[2]}` : 'redis://<invalid>';
};

const clients = new Set<Redis>();
let appClient: Redis | undefined;

/**
 * Creates a tracked ioredis connection. `maxRetriesPerRequest: null` is required
 * by BullMQ and harmless elsewhere. Every connection is closed by `closeAllRedis()`.
 */
export const createRedis = (url: string, name: string, logger: Logger): Redis => {
  const target = redactRedisUrl(url);
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `cav:${name}`,
  });
  client.on('ready', () => logger.debug({ target, name }, 'redis: ready'));
  client.on('error', (err: unknown) => logger.error({ err, target, name }, 'redis: error'));
  client.on('end', () => logger.debug({ target, name }, 'redis: connection ended'));
  clients.add(client);
  client.once('end', () => clients.delete(client));
  return client;
};

/** Shared connection for commands (rate limit, WS tickets, publish). */
export const getAppRedis = (url: string, logger: Logger): Redis => {
  appClient ??= createRedis(url, 'app', logger);
  return appClient;
};

/** Dedicated pub/sub subscriber (a subscribed connection can't run other commands). */
export const createSubscriber = (url: string, logger: Logger): Redis =>
  createRedis(url, 'subscriber', logger);

/** True when PING answers within `timeoutMs`. Never throws. */
export const pingRedis = async (client: Redis, timeoutMs = 2000): Promise<boolean> => {
  if (client.status === 'end' || client.status === 'close') return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const ping = client
      .ping()
      .then((r) => r === 'PONG')
      .catch(() => false);
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Graceful QUIT for every tracked connection (falls back to disconnect after 2 s). */
export const closeAllRedis = async (): Promise<void> => {
  const all = [...clients];
  clients.clear();
  appClient = undefined;
  await Promise.all(
    all.map(async (client) => {
      if (client.status === 'end') return;
      const ended = new Promise<void>((resolve) => client.once('end', () => resolve()));
      const force = setTimeout(() => client.disconnect(), 2000);
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
      await ended;
      clearTimeout(force);
    }),
  );
};
