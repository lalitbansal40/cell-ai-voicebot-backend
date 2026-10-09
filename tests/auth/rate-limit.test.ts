import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AUTH_RATE_LIMIT, AUTH_REFRESH_RATE_LIMIT } from '../../src/config/limits';
import { buildTestApp } from '../helpers/test-app';

const ORIGIN = 'http://localhost:3100';

describe('auth rate limits (default settings)', () => {
  it('refresh (every page load) gets far more room than the brute-forceable routes', async () => {
    expect(AUTH_REFRESH_RATE_LIMIT).toBeGreaterThan(AUTH_RATE_LIMIT.limit * 10);
    const app = buildTestApp();
    // an office behind one NAT reloading pages: no session cookie → 401, never 429
    for (let i = 0; i <= AUTH_RATE_LIMIT.limit; i += 1) {
      const res = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN);
      expect(res.status).toBe(401);
    }
    // login on the same IP still stops at the strict limit (bad body → 422 until then)
    let last = 0;
    for (let i = 0; i <= AUTH_RATE_LIMIT.limit; i += 1) {
      last = (await request(app).post('/api/v1/auth/login').send({})).status;
    }
    expect(last).toBe(429);
  });
});
