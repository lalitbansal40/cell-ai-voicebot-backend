import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/test-app';

const ORIGIN = 'http://localhost:3100';

describe('security headers', () => {
  const app = buildTestApp();

  it('sets helmet headers and hides x-powered-by', async () => {
    const res = await request(app).get('/api/v1/system/info');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not send HSTS outside production', async () => {
    const res = await request(app).get('/api/v1/system/info');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('CORS allowlist', () => {
  const app = buildTestApp({ CORS_ORIGINS: ORIGIN });

  it('allows a listed origin with credentials and exposes our headers', async () => {
    const res = await request(app).get('/api/v1/system/info').set('Origin', ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });

  it('sends no CORS headers for an unknown origin (browser blocks it)', async () => {
    const res = await request(app).get('/api/v1/system/info').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight with 204 and the allowed headers', async () => {
    const res = await request(app)
      .options('/api/v1/system/info')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Idempotency-Key');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('allows requests without an Origin header (server-to-server)', async () => {
    const res = await request(app).get('/api/v1/system/info');
    expect(res.status).toBe(200);
  });
});

describe('body limits', () => {
  const app = buildTestApp();

  it('rejects JSON bodies over 1 MB with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/v1/system/info')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects urlencoded bodies over 100 KB', async () => {
    const res = await request(app)
      .post('/api/v1/system/info')
      .type('form')
      .send(`a=${'x'.repeat(110 * 1024)}`);
    expect(res.status).toBe(413);
  });

  it('rejects malformed JSON with 400 REQUEST_MALFORMED', async () => {
    const res = await request(app)
      .post('/api/v1/system/info')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REQUEST_MALFORMED');
  });
});

describe('rate limiting', () => {
  it('returns 429 RATE_LIMITED with RateLimit-* and Retry-After headers', async () => {
    const app = buildTestApp({}, { rateLimit: { windowMs: 60_000, limit: 2 } });
    const first = await request(app).get('/api/v1/system/info');
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    await request(app).get('/api/v1/system/info');
    const res = await request(app).get('/api/v1/system/info');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['ratelimit-remaining']).toBe('0');
  });

  it('honours trust proxy: X-Forwarded-For separates clients', async () => {
    const app = buildTestApp({ TRUST_PROXY: '1' }, { rateLimit: { windowMs: 60_000, limit: 1 } });
    const a = await request(app).get('/api/v1/system/info').set('X-Forwarded-For', '203.0.113.1');
    const b = await request(app).get('/api/v1/system/info').set('X-Forwarded-For', '203.0.113.2');
    const a2 = await request(app).get('/api/v1/system/info').set('X-Forwarded-For', '203.0.113.1');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a2.status).toBe(429);
  });

  it('exempts health paths', async () => {
    const app = buildTestApp({}, { rateLimit: { windowMs: 60_000, limit: 1 } });
    await request(app).get('/health');
    const res = await request(app).get('/health');
    expect(res.status).toBe(404); // route arrives in T1.9 — but never 429
  });
});
