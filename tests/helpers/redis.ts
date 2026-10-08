import { randomBytes } from 'node:crypto';

import { Redis } from 'ioredis';

import { testEnv } from './test-app';

/** Real Redis from REDIS_URL (local Docker / CI service). Fails loudly if it is not running. */
export const requireRedis = async (): Promise<{ url: string; client: Redis }> => {
  const url = testEnv().REDIS_URL;
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 2000,
  });
  try {
    await client.connect();
    await client.ping();
  } catch {
    client.disconnect();
    throw new Error(`Redis not reachable at ${url} — run "npm run infra:up"`);
  }
  return { url, client };
};

/** Unique key prefix per test file / run. */
export const uniquePrefix = (name: string): string =>
  `test:${name}:${randomBytes(4).toString('hex')}`;

/** Deletes keys under a prefix with SCAN (never FLUSHALL). */
export const flushPrefix = async (client: Redis, prefix: string): Promise<void> => {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) await client.del(...keys);
  } while (cursor !== '0');
};
