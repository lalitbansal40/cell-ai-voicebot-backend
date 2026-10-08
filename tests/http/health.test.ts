import { Writable } from 'node:stream';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { ReadinessDeps } from '../../src/modules/health/health.controller';
import { HealthSchema, ReadinessSchema } from '../../src/modules/health/health.schema';
import { createLogger } from '../../src/shared/logger';
import { testEnv } from '../helpers/test-app';

const build = (readiness: ReadinessDeps, rateLimit?: { windowMs: number; limit: number }) => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const env = testEnv();
  const app = createApp({
    env,
    logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'info' }, stream),
    readiness,
    rateLimit,
  });
  return { app, lines };
};

const up = () => Promise.resolve(true);
const down = () => Promise.resolve(false);

describe('GET /health', () => {
  it('returns ok with uptime and never calls dependencies', async () => {
    let called = false;
    const { app } = build({
      checks: {
        mongo: () => {
          called = true;
          return up();
        },
      },
      isShuttingDown: () => false,
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(HealthSchema.parse(res.body.data).status).toBe('ok');
    expect(called).toBe(false);
  });
});

describe('GET /ready', () => {
  it('returns 200 when every check is up', async () => {
    const { app } = build({ checks: { mongo: up, redis: up }, isShuttingDown: () => false });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(ReadinessSchema.parse(res.body.data)).toEqual({
      status: 'ready',
      checks: { mongo: 'up', redis: 'up' },
    });
  });

  it('returns 503 PROVIDER_UNAVAILABLE listing the down dependency', async () => {
    const { app } = build({ checks: { mongo: up, redis: down }, isShuttingDown: () => false });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(res.body.error.details).toEqual([{ path: 'redis', message: 'down' }]);
  });

  it('treats a throwing check as down', async () => {
    const { app } = build({
      checks: { mongo: () => Promise.reject(new Error('x')) },
      isShuttingDown: () => false,
    });
    expect((await request(app).get('/ready')).status).toBe(503);
  });

  it('treats a hanging check as down after the timeout', async () => {
    const { app } = build({
      checks: { mongo: () => new Promise<boolean>(() => undefined) },
      isShuttingDown: () => false,
      timeoutMs: 50,
    });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.details).toEqual([{ path: 'mongo', message: 'down' }]);
  });

  it('returns 503 while shutting down', async () => {
    const { app } = build({ checks: { mongo: up }, isShuttingDown: () => true });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.details).toEqual([{ path: 'server', message: 'shutting down' }]);
  });

  it('is never rate-limited and never access-logged', async () => {
    const { app, lines } = build(
      { checks: { mongo: up }, isShuttingDown: () => false },
      { windowMs: 60_000, limit: 1 },
    );
    for (let i = 0; i < 3; i += 1) expect((await request(app).get('/ready')).status).toBe(200);
    expect(lines.filter((l) => l.includes('"/ready"'))).toHaveLength(0);
  });
});
