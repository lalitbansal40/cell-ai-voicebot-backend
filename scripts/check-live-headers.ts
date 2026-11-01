/**
 * Read-only check of a live site's security headers (Phase 16). Tests every address the
 * host name resolves to, because one bad DNS record fails only some visitors.
 *
 *   npm run check:headers -- https://<app-host>
 *
 * Sends only public GET requests, never a login. Exits 1 on a problem.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { runOp, say } from '../src/ops/cli';

/** Anything that can be read by header name (`fetch` Headers or a plain lookup). */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Two values arrive joined by a comma, and one value never has a second `max-age`. */
const hstsProblems = (headers: HeaderReader): string[] => {
  const hsts = headers.get('strict-transport-security');
  if (!hsts) return ['no Strict-Transport-Security header'];
  return (hsts.match(/max-age/gi) ?? []).length > 1 ? ['Strict-Transport-Security sent twice'] : [];
};

/** The headers every API answer must carry. */
export const apiHeaderProblems = (headers: HeaderReader): string[] => [
  ...hstsProblems(headers),
  ...(headers.get('x-content-type-options')?.toLowerCase() === 'nosniff'
    ? []
    : ['no X-Content-Type-Options: nosniff']),
];

/** The headers the app's HTML page must carry. */
export const pageHeaderProblems = (headers: HeaderReader): string[] => {
  const csp = headers.get('content-security-policy');
  const reportOnly = headers.get('content-security-policy-report-only');
  return [
    ...apiHeaderProblems(headers),
    ...(headers.get('x-frame-options') || csp?.includes('frame-ancestors')
      ? []
      : ['no X-Frame-Options or frame-ancestors']),
    ...(headers.get('referrer-policy') ? [] : ['no Referrer-Policy']),
    ...(headers.get('permissions-policy') ? [] : ['no Permissions-Policy']),
    ...(csp || reportOnly ? [] : ['no Content-Security-Policy']),
  ];
};

export interface AddressReport {
  address: string;
  ok: boolean;
  problems: string[];
  /** Not a failure, worth reading: a CSP still in report-only mode. */
  notes: string[];
}

interface Answer {
  status: number;
  headers: HeaderReader;
  body: string;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const reader = (headers: IncomingHttpHeaders): HeaderReader => ({
  get: (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value.join(', ') : (value ?? null);
  },
});

/** GET one path from one address; the TLS certificate is still checked against the host name. */
const fetchFrom = (url: URL, address: string, path: string, timeoutMs: number): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port || (secure ? 443 : 80),
        path,
        method: 'GET',
        agent: false,
        timeout: timeoutMs,
        headers: { host: url.host, accept: '*/*', 'user-agent': 'cav-check-headers' },
        ...(secure ? { servername: url.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: reader(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timed out'));
    });
    req.on('error', reject);
    req.end();
  });

const checkAddress = async (url: URL, address: string, timeoutMs: number) => {
  const report: AddressReport = { address, ok: false, problems: [], notes: [] };
  try {
    const page = await fetchFrom(url, address, '/', timeoutMs);
    if (page.status !== 200) report.problems.push(`/ answered ${String(page.status)}`);
    report.problems.push(...pageHeaderProblems(page.headers).map((p) => `/: ${p}`));
    if (page.headers.get('content-security-policy-report-only'))
      report.notes.push('Content-Security-Policy is report-only');

    const health = await fetchFrom(url, address, '/api/v1/health', timeoutMs);
    if (health.status !== 200) report.problems.push(`health answered ${String(health.status)}`);
    report.problems.push(...apiHeaderProblems(health.headers).map((p) => `health: ${p}`));

    for (const path of ['/ready', '/api/v1/ready']) {
      const ready = await fetchFrom(url, address, path, timeoutMs);
      if (ready.status !== 404)
        report.problems.push(`public ${path} answered ${String(ready.status)}`);
    }

    const spec = await fetchFrom(url, address, '/api/v1/openapi.json', timeoutMs);
    if (spec.body.includes('/api/v1/admin/'))
      report.problems.push('/api/v1/openapi.json lists the admin routes');
  } catch (err) {
    report.problems.push(`request failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  report.ok = report.problems.length === 0;
  return report;
};

export const checkLiveHeaders = async (
  target: string,
  {
    resolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address),
    timeoutMs = 10_000,
  }: { resolve?: (host: string) => Promise<string[]>; timeoutMs?: number } = {},
): Promise<AddressReport[]> => {
  const url = new URL(target);
  const addresses = [...new Set(await resolve(url.hostname))];
  return Promise.all(addresses.map((address) => checkAddress(url, address, timeoutMs)));
};

const main = async (args: string[]): Promise<void> => {
  const target = args[0];
  if (!target || !/^https?:\/\/[^\s/]+/.test(target))
    throw new Error('Usage: npm run check:headers -- <https://host>');
  const reports = await checkLiveHeaders(target);
  for (const r of reports) {
    say(`${r.ok ? '✓' : '✗'} ${r.address}`);
    for (const p of r.problems) say(`    problem: ${p}`);
    for (const n of r.notes) say(`    note: ${n}`);
  }
  if (reports.some((r) => !r.ok)) throw new Error('header check failed');
  say(`headers ok (${String(reports.length)} address(es))`);
};

if (require.main === module) runOp(main);
