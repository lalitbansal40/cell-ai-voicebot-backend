import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSmokeArgs, runSmoke } from '../../scripts/smoke';

/** A tiny stand-in for nginx + the API; `over` changes one answer per test. */
type Answer = { status: number; body?: string; headers?: Record<string, string> };
const DEFAULTS: Record<string, Answer> = {
  '/api/v1/health': {
    status: 200,
    body: JSON.stringify({ data: { status: 'ok', commit: 'abc1234' } }),
    headers: { 'strict-transport-security': 'max-age=1' },
  },
  // nginx blocks readiness from the internet (404 by default here too)
  '/': {
    status: 200,
    body: '<html><div id="root"></div><script src="/assets/index-AbC123.js"></script></html>',
    headers: { 'cache-control': 'no-cache' },
  },
  '/assets/index-AbC123.js': {
    status: 200,
    body: 'x',
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  },
  '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /\n' },
  '/privacy': { status: 200 },
  '/terms': { status: 200 },
  '/contact': { status: 200 },
  '/data-deletion': { status: 200 },
  'POST /api/v1/auth/login': {
    status: 200,
    body: JSON.stringify({ data: { accessToken: 'tok' } }),
  },
  'POST /api/v1/ws/tickets': { status: 201, body: JSON.stringify({ data: { ticket: 'wst_1' } }) },
};

let server: Server | undefined;
const seen: string[] = [];
const serve = async (over: Record<string, Answer> = {}) => {
  const answers = { ...DEFAULTS, ...over };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(`${req.method ?? ''} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/v1/webhooks/meta') {
      const ok = url.searchParams.get('hub.verify_token') === 'verify-token-123456789012';
      res.writeHead(ok ? 200 : 403);
      res.end(ok ? (url.searchParams.get('hub.challenge') ?? '') : '');
      return;
    }
    const a = answers[`${req.method ?? ''} ${url.pathname}`] ?? answers[url.pathname];
    res.writeHead(a?.status ?? 404, a?.headers ?? {});
    res.end(a?.body ?? '');
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${String((server?.address() as AddressInfo).port)}`;
};
afterEach(async () => {
  seen.length = 0;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const opened: string[] = [];
const open = (url: string) => {
  opened.push(url);
  return Promise.resolve();
};

describe('smoke', () => {
  it('every public check passes; the password and token never leave in a URL', async () => {
    const url = await serve();
    const results = await runSmoke(
      {
        url,
        internal: false,
        expectCommit: 'abc1234',
        demoEmail: 'review@example.com',
        demoPassword: 'secret-password',
        verifyToken: 'verify-token-123456789012',
      },
      { open },
    );
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['health', true],
      ['ready is not public', true],
      ['app shell + cache headers', true],
      ['robots + legal pages', true],
      ['demo sign-in', true],
      ['websocket', true],
      ['meta webhook verify', true],
    ]);
    expect(opened[0]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\/events\?ticket=wst_1$/);
    expect(seen.join('\n')).not.toContain('secret-password');
  });

  it('internal mode checks /ready = 200 and skips the SPA checks', async () => {
    const url = await serve({ '/api/v1/ready': { status: 200 } });
    const results = await runSmoke({ url, internal: true }, { open });
    expect(results.map((r) => r.name)).toEqual(['health', 'ready']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('internal mode fails while the API is not ready', async () => {
    const url = await serve({ '/api/v1/ready': { status: 503 } });
    const results = await runSmoke({ url, internal: true }, { open });
    expect(results.at(-1)).toMatchObject({ name: 'ready', ok: false, detail: 'status 503' });
  });

  it.each([
    [
      'wrong commit',
      {
        '/api/v1/health': {
          status: 200,
          body: JSON.stringify({ data: { status: 'ok', commit: 'old0000' } }),
        },
      },
      'health',
      /commit old0000/,
    ],
    [
      'public readiness',
      { '/api/v1/ready': { status: 200 } },
      'ready is not public',
      /public \/api\/v1\/ready answered 200/,
    ],
    [
      'cached index',
      { '/': { status: 200, body: '<div id="root"></div>' } },
      'app shell + cache headers',
      /cached/,
    ],
    [
      'robots allows',
      { '/robots.txt': { status: 200, body: 'User-agent: *' } },
      'robots + legal pages',
      /indexing/,
    ],
    [
      'missing legal page',
      { '/terms': { status: 404 } },
      'robots + legal pages',
      /\/terms status 404/,
    ],
    ['bad login', { 'POST /api/v1/auth/login': { status: 401 } }, 'demo sign-in', /status 401/],
    [
      'no ticket',
      { 'POST /api/v1/ws/tickets': { status: 201, body: '{}' } },
      'websocket',
      /no ticket/,
    ],
  ] as const)('stops at the first failure: %s', async (_name, over, failed, detail) => {
    const url = await serve(over);
    const results = await runSmoke(
      {
        url,
        internal: false,
        expectCommit: 'abc1234',
        demoEmail: 'review@example.com',
        demoPassword: 'secret-password',
      },
      { open },
    );
    const last = results.at(-1);
    expect(last).toMatchObject({ name: failed, ok: false });
    expect(last?.detail).toMatch(detail);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it('a wrong verify token fails; https needs HSTS; a dead host is a failed request', async () => {
    const url = await serve({ '/api/v1/ready': { status: 200 } });
    const wrong = await runSmoke({ url, internal: true, verifyToken: 'nope' }, { open });
    expect(wrong.at(-1)).toMatchObject({ name: 'meta webhook verify', ok: false });
    const dead = await runSmoke(
      { url: 'http://127.0.0.1:9', internal: true },
      { open, fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) },
    );
    expect(dead).toEqual([{ name: 'health', ok: false, detail: 'request failed' }]);
    const noHsts = await runSmoke(
      { url: 'https://staging.example.com', internal: true },
      {
        open,
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ data: { status: 'ok' } }), { status: 200 }),
          ),
      },
    );
    expect(noHsts[0]).toMatchObject({ ok: false, detail: 'no Strict-Transport-Security header' });
  });

  it('parses arguments; secrets come from the environment only', () => {
    expect(() => parseSmokeArgs([], {})).toThrow('Usage');
    expect(() => parseSmokeArgs(['--url', 'ftp://x'], {})).toThrow('Usage');
    expect(
      parseSmokeArgs(
        [
          '--url',
          'https://staging.example.com',
          '--expect-commit',
          'abc1234',
          '--demo-email',
          'r@example.com',
          '--demo-password-env',
          'DEMO_PW',
        ],
        { DEMO_PW: 'pw', META_WEBHOOK_VERIFY_TOKEN: 'tok' },
      ),
    ).toEqual({
      url: 'https://staging.example.com',
      internal: false,
      expectCommit: 'abc1234',
      demoEmail: 'r@example.com',
      demoPassword: 'pw',
      verifyToken: 'tok',
    });
    expect(parseSmokeArgs(['--url', 'http://127.0.0.1:5100', '--internal'], {})).toMatchObject({
      internal: true,
      demoPassword: undefined,
      verifyToken: undefined,
    });
  });
});
