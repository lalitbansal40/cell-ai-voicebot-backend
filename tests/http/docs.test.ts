import { readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../../src/openapi';
import { getAppInfo } from '../../src/shared/app-info';
import { PRODUCTION_BILLING_ENV } from '../helpers/production-env';
import { buildTestApp } from '../helpers/test-app';

const pkgVersion = (
  JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const production = {
  NODE_ENV: 'production',
  APP_URL: 'https://api.example.com',
  FRONTEND_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  MONGODB_URI: 'mongodb://db.internal:27017/cav?replicaSet=rs0',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdefXYZ',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdefXYZ',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Cell AI Voicebot <no-reply@example.com>',
  ...PRODUCTION_BILLING_ENV,
};

describe('GET /api/v1/openapi.json', () => {
  const app = buildTestApp({ APP_URL: 'https://api.test.example' });

  it('serves the OpenAPI 3.1 document with APP_URL as server', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.success).toBeUndefined(); // raw document, not enveloped
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/ready', '/api/v1/system/info']),
    );
    expect(res.body.servers).toEqual([
      { url: 'https://api.test.example', description: 'This server' },
    ]);
    expect(res.body.info.version).toBe(pkgVersion);
  });

  it('supports conditional requests (ETag → 304)', async () => {
    const first = await request(app).get('/api/v1/openapi.json');
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    const second = await request(app)
      .get('/api/v1/openapi.json')
      .set('If-None-Match', String(etag));
    expect(second.status).toBe(304);
  });

  it('is served in production too, with Swagger UI off', async () => {
    const prod = buildTestApp(production);
    expect((await request(prod).get('/api/v1/openapi.json')).status).toBe(200);
    expect((await request(prod).get('/api/docs')).status).toBe(404);
  });
});

describe('buildOpenApiDocument', () => {
  it('uses the package version even without npm_package_version', () => {
    const saved = process.env.npm_package_version;
    delete process.env.npm_package_version;
    try {
      expect(getAppInfo().version).toBe(pkgVersion);
      expect(buildOpenApiDocument().info.version).toBe(pkgVersion);
    } finally {
      if (saved !== undefined) process.env.npm_package_version = saved;
    }
  });

  it('keeps the local server URL for the committed file', () => {
    expect(buildOpenApiDocument().servers).toEqual([
      { url: 'http://localhost:5100', description: 'Local development' },
    ]);
  });
});

describe('Swagger UI (/api/docs)', () => {
  const app = buildTestApp();

  it('serves the page with a strict CSP and no inline scripts', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);
    const html = res.text;
    expect(html).toContain('<div id="swagger-ui"></div>');
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBe(2);
    for (const tag of scripts) expect(tag).toMatch(/src="\/api\/docs\//);
    expect(/<script[^>]*>[^<]+<\/script>/.test(html)).toBe(false);
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it('also answers on /api/docs/', async () => {
    expect((await request(app).get('/api/docs/')).status).toBe(200);
  });

  it('serves the init script pointing at our spec', async () => {
    const res = await request(app).get('/api/docs/init.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.text).toContain("url: '/api/v1/openapi.json'");
  });

  it('serves Swagger UI assets', async () => {
    const js = await request(app).get('/api/docs/assets/swagger-ui-bundle.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    const css = await request(app).get('/api/docs/assets/swagger-ui.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('never serves the Petstore initializer or the stock index.html', async () => {
    for (const asset of ['swagger-initializer.js', 'index.html']) {
      const res = await request(app).get(`/api/docs/assets/${asset}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('is off when API_DOCS_ENABLED=false (spec still served)', async () => {
    const off = buildTestApp({ API_DOCS_ENABLED: 'false' });
    const res = await request(off).get('/api/docs');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await request(off).get('/api/v1/openapi.json')).status).toBe(200);
  });

  it('can be enabled in production explicitly', async () => {
    const prod = buildTestApp({ ...production, API_DOCS_ENABLED: 'true' });
    expect((await request(prod).get('/api/docs')).status).toBe(200);
  });

  it('keeps CSP off on JSON API routes', async () => {
    const res = await request(app).get('/api/v1/system/info');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
