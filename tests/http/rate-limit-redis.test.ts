import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import { createLogger } from '../../src/shared/logger';
import { createRedisRateLimitStore } from '../../src/shared/middlewares/rate-limit';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

describe('Redis rate-limit store', () => {
  let client: Redis;
  const prefix = `${uniquePrefix('rl')}:`;

  beforeAll(async () => {
    client = (await requireRedis()).client;
  });

  afterAll(async () => {
    await flushPrefix(client, prefix);
    client.disconnect();
  });

  it('shares counters across two app instances', async () => {
    const env = testEnv();
    const logger = createLogger(env);
    const build = () =>
      createApp({
        env,
        logger,
        rateLimit: { windowMs: 60_000, limit: 2 },
        rateLimitStore: createRedisRateLimitStore(client, prefix),
      });
    const appA = build();
    const appB = build();
    expect((await request(appA).get('/api/v1/system/info')).status).toBe(200);
    expect((await request(appB).get('/api/v1/system/info')).status).toBe(200);
    const third = await request(appA).get('/api/v1/system/info');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });
});
