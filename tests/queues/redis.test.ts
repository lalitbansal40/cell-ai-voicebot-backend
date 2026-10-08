import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeAllRedis,
  createRedis,
  getAppRedis,
  pingRedis,
  redactRedisUrl,
} from '../../src/core/queues/redis';
import { createLogger } from '../../src/shared/logger';
import { requireRedis } from '../helpers/redis';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

describe('redactRedisUrl', () => {
  it.each([
    ['redis://:secret@cache.internal:6379/0', 'redis://cache.internal:6379'],
    ['rediss://user:pw@host:6380', 'rediss://host:6380'],
    ['redis://127.0.0.1:6380', 'redis://127.0.0.1:6380'],
    ['nope', 'redis://<invalid>'],
  ])('%s → %s', (url, expected) => expect(redactRedisUrl(url)).toBe(expected));
});

describe('redis connections', () => {
  let url: string;

  beforeAll(async () => {
    const r = await requireRedis();
    url = r.url;
    r.client.disconnect();
  });

  afterAll(async () => {
    await closeAllRedis();
  });

  it('pings a live connection', async () => {
    expect(await pingRedis(getAppRedis(url, logger))).toBe(true);
  });

  it('reuses the shared app connection', () => {
    expect(getAppRedis(url, logger)).toBe(getAppRedis(url, logger));
  });

  it('closeAllRedis quits every tracked connection; ping is then false', async () => {
    const extra = createRedis(url, 'extra', logger);
    await pingRedis(extra);
    await closeAllRedis();
    expect(extra.status).toBe('end');
    expect(await pingRedis(extra)).toBe(false);
  });
});
