import { readdirSync, readFileSync } from 'node:fs';
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

describe('OpenAPI coverage', () => {
  const src = path.resolve(__dirname, '..', '..', 'src');
  const schemaFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? schemaFiles(path.join(dir, e.name))
        : e.name.endsWith('.schema.ts')
          ? [path.join(dir, e.name)]
          : [],
    );

  it('every module schema that registers paths is imported by src/openapi.ts', () => {
    const index = readFileSync(path.join(src, 'openapi.ts'), 'utf8');
    const missing = schemaFiles(path.join(src, 'modules'))
      .filter((f) => readFileSync(f, 'utf8').includes('registry.registerPath('))
      .map((f) => `./${path.relative(src, f).replace(/\.ts$/, '')}`)
      .filter((rel) => !index.includes(`import '${rel}';`));
    expect(missing).toEqual([]);
  });

  it('documents the Phase 8 routes', () => {
    const paths = Object.keys(buildOpenApiDocument().paths ?? {});
    for (const p of [
      '/api/v1/campaigns',
      '/api/v1/campaigns/{id}',
      '/api/v1/campaigns/{id}/start',
      '/api/v1/campaigns/{id}/export',
      '/api/v1/campaigns/audience/preview',
      '/api/v1/calls',
      '/api/v1/admin/accounts/{id}/limits',
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it('documents the Phase 9 routes', () => {
    const doc = buildOpenApiDocument();
    const paths = Object.keys(doc.paths ?? {});
    for (const p of [
      '/api/v1/whatsapp/config',
      '/api/v1/whatsapp/channels',
      '/api/v1/whatsapp/channels/embedded-signup',
      '/api/v1/whatsapp/channels/{id}',
      '/api/v1/whatsapp/channels/{id}/sync',
      '/api/v1/whatsapp/channels/{id}/retry-setup',
      '/api/v1/whatsapp/channels/{id}/register',
      '/api/v1/whatsapp/channels/{id}/coexistence-sync',
      '/api/v1/whatsapp/channels/{id}/disconnect',
      '/api/v1/webhooks/meta',
      '/api/v1/meta/deauthorize',
      '/api/v1/meta/data-deletion',
      '/api/v1/meta/data-deletion/{code}',
      '/api/v1/admin/whatsapp/status',
      '/api/v1/admin/whatsapp/events',
      '/api/v1/admin/whatsapp/events/{id}/replay',
      '/api/v1/admin/whatsapp/channels/{id}/disconnect',
      '/api/v1/admin/accounts/{id}/whatsapp-billing',
      '/api/v1/admin/accounts/{id}/whatsapp/manual-connect',
      '/api/v1/dev/meta/webhooks',
    ]) {
      expect(paths, p).toContain(p);
    }
    // no secrets or examples of them in the document
    expect(JSON.stringify(doc)).not.toMatch(
      /fake_tok_|dev-fake-meta-app-secret|dev-meta-verify-token/,
    );
  });

  it('documents the Phase 10 routes', () => {
    const doc = buildOpenApiDocument();
    const paths = Object.keys(doc.paths ?? {});
    for (const p of [
      '/api/v1/inbox/config',
      '/api/v1/inbox/summary',
      '/api/v1/inbox/conversations',
      '/api/v1/inbox/conversations/start',
      '/api/v1/inbox/conversations/{id}',
      '/api/v1/inbox/conversations/{id}/messages',
      '/api/v1/inbox/conversations/{id}/contact',
      '/api/v1/inbox/conversations/{id}/read',
      '/api/v1/inbox/conversations/{id}/unread',
      '/api/v1/inbox/conversations/{id}/typing',
      '/api/v1/inbox/conversations/{id}/close',
      '/api/v1/inbox/conversations/{id}/reopen',
      '/api/v1/inbox/conversations/{id}/block',
      '/api/v1/inbox/conversations/{id}/unblock',
      '/api/v1/inbox/media',
      '/api/v1/inbox/messages/{id}/media',
      '/api/v1/inbox/messages/{id}/retry',
      '/api/v1/inbox/messages/{id}/media/retry',
      '/api/v1/account/inbox-settings',
      '/api/v1/whatsapp/channels/{id}/profile',
      '/api/v1/whatsapp/channels/{id}/profile/photo',
    ]) {
      expect(paths, p).toContain(p);
    }
    const send = doc.paths?.['/api/v1/inbox/conversations/{id}/messages']?.post;
    expect(JSON.stringify(send)).toContain('InboxSendMessage');
    expect(JSON.stringify(doc.components?.schemas?.InboxMessage)).not.toContain('storageKey');
  });
});
