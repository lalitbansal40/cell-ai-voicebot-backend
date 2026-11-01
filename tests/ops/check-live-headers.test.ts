import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  apiHeaderProblems,
  checkLiveHeaders,
  pageHeaderProblems,
} from '../../scripts/check-live-headers';

const API = { 'strict-transport-security': 'max-age=1', 'x-content-type-options': 'nosniff' };
const PAGE = {
  ...API,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=()',
  'content-security-policy': "default-src 'self'",
};

const headers = (values: Record<string, string>) => new Headers(values);

let server: Server | undefined;
const seen: string[] = [];
const serve = async (page: Record<string, string> = PAGE, spec = '{"paths":{}}') => {
  server = createServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''} ${req.headers.host ?? ''}`);
    if (req.url === '/') res.writeHead(200, page);
    else if (req.url === '/api/v1/health') res.writeHead(200, API);
    else if (req.url === '/api/v1/openapi.json') res.writeHead(200, API);
    else res.writeHead(404);
    res.end(req.url === '/api/v1/openapi.json' ? spec : '');
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://app.example.test:${String((server?.address() as AddressInfo).port)}`;
};
afterEach(async () => {
  seen.length = 0;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('header rules', () => {
  it('accepts the full set', () => {
    expect(pageHeaderProblems(headers(PAGE))).toEqual([]);
    expect(apiHeaderProblems(headers(API))).toEqual([]);
  });

  it('names each missing header', () => {
    expect(pageHeaderProblems(headers({}))).toEqual([
      'no Strict-Transport-Security header',
      'no X-Content-Type-Options: nosniff',
      'no X-Frame-Options or frame-ancestors',
      'no Referrer-Policy',
      'no Permissions-Policy',
      'no Content-Security-Policy',
    ]);
  });

  it('refuses a doubled Strict-Transport-Security', () => {
    const doubled = headers({ ...API });
    doubled.append('strict-transport-security', 'max-age=2');
    expect(apiHeaderProblems(doubled)).toEqual(['Strict-Transport-Security sent twice']);
  });

  it('frame-ancestors can stand in for X-Frame-Options', () => {
    const { 'x-frame-options': _unused, ...rest } = PAGE;
    const page = { ...rest, 'content-security-policy': "frame-ancestors 'none'" };
    expect(pageHeaderProblems(headers(page))).toEqual([]);
  });
});

describe('checkLiveHeaders', () => {
  it('passes a good site, sends only GET and keeps the host name', async () => {
    const url = await serve();
    const reports = await checkLiveHeaders(url, { resolve: () => Promise.resolve(['127.0.0.1']) });
    expect(reports).toEqual([{ address: '127.0.0.1', ok: true, problems: [], notes: [] }]);
    expect(seen.every((s) => s.startsWith('GET '))).toBe(true);
    expect(seen.every((s) => s.endsWith(new URL(url).host))).toBe(true);
  });

  it('reports one bad address separately, even when another works', async () => {
    const url = await serve();
    const reports = await checkLiveHeaders(url, {
      resolve: () => Promise.resolve(['127.0.0.1', '127.0.0.1', '127.255.255.254']),
      timeoutMs: 2_000,
    });
    expect(reports.map((r) => [r.address, r.ok])).toEqual([
      ['127.0.0.1', true],
      ['127.255.255.254', false],
    ]);
    expect(reports[1]?.problems[0]).toMatch(/^request failed/);
  });

  it('flags missing headers and a public full API spec', async () => {
    const url = await serve(API, '{"paths":{"/api/v1/admin/accounts":{}}}');
    const [report] = await checkLiveHeaders(url, {
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    expect(report?.problems).toEqual([
      '/: no X-Frame-Options or frame-ancestors',
      '/: no Referrer-Policy',
      '/: no Permissions-Policy',
      '/: no Content-Security-Policy',
      '/api/v1/openapi.json lists the admin routes',
    ]);
  });

  it('notes a report-only CSP without failing', async () => {
    const { 'content-security-policy': _unused, ...rest } = PAGE;
    const url = await serve({
      ...rest,
      'content-security-policy-report-only': "default-src 'self'",
    });
    const [report] = await checkLiveHeaders(url, {
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    expect(report).toMatchObject({
      ok: true,
      notes: ['Content-Security-Policy is report-only'],
    });
  });
});
