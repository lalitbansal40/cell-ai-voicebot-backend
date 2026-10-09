import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { executeFunction, type HttpToolOptions } from '../../src/core/ai/http-tool';
import {
  addressBlockReason,
  urlBlockReason,
  unmapIpv4,
  type GuardPolicy,
} from '../../src/core/ai/ip-guard';
import { seal } from '../../src/core/ai/secret-box';
import type { AgentFunction } from '../../src/db/models/ai-agent.model';
import { json, useStubServer } from '../helpers/stub-server';

const PROD: GuardPolicy = { httpsOnly: true, allowPrivate: false };
const DEV: GuardPolicy = { httpsOnly: false, allowPrivate: true };

describe('ip guard — production policy', () => {
  it.each([
    ['http://api.example.com/x', 'scheme'],
    ['ftp://api.example.com/x', 'scheme'],
    ['https://127.0.0.1/x', 'private'],
    ['https://10.0.0.5/x', 'private'],
    ['https://172.20.1.1/x', 'private'],
    ['https://192.168.1.10/x', 'private'],
    ['https://100.64.0.1/x', 'private'],
    ['https://169.254.169.254/latest/meta-data', 'reserved'],
    ['https://0.0.0.0/x', 'reserved'],
    ['https://224.0.0.1/x', 'reserved'],
    ['https://[::1]/x', 'private'],
    ['https://[fe80::1]/x', 'reserved'],
    ['https://[fc00::1]/x', 'private'],
    ['https://[::ffff:127.0.0.1]/x', 'private'],
    ['https://[::ffff:a9fe:a9fe]/x', 'reserved'],
    ['https://localhost/x', 'private'],
    ['https://api.localhost/x', 'private'],
    ['https://api.example.com:22/x', 'port'],
    ['https://api.example.com:5100/x', 'port'],
    ['https://user:pass@api.example.com/x', 'invalid'],
  ])('%s → %s', (url, reason) => {
    expect(urlBlockReason(new URL(url), PROD)).toBe(reason);
  });

  it.each([
    'https://api.example.com/x',
    'https://api.example.com:443/x',
    'https://api.example.com:8443/x',
    'https://8.8.8.8/x',
    'https://[2606:4700::1111]/x',
  ])('%s is allowed', (url) => {
    expect(urlBlockReason(new URL(url), PROD)).toBeNull();
  });
});

describe('ip guard — development policy', () => {
  it('allows loopback / private but never metadata, link-local or multicast', () => {
    expect(urlBlockReason(new URL('http://127.0.0.1:8080/x'), DEV)).toBeNull();
    expect(urlBlockReason(new URL('http://localhost:8000/x'), DEV)).toBeNull();
    expect(urlBlockReason(new URL('http://10.0.0.5/x'), DEV)).toBeNull();
    expect(urlBlockReason(new URL('http://169.254.169.254/x'), DEV)).toBe('reserved');
    expect(urlBlockReason(new URL('http://[fe80::1]/x'), DEV)).toBe('reserved');
    expect(urlBlockReason(new URL('http://239.1.1.1/x'), DEV)).toBe('reserved');
    expect(urlBlockReason(new URL('http://127.0.0.1:22/x'), DEV)).toBe('port');
    expect(
      urlBlockReason(new URL('http://127.0.0.1:5100/x'), { ...DEV, extraPorts: [5100] }),
    ).toBeNull();
  });

  it('checks resolved addresses and unmaps IPv4-in-IPv6', () => {
    expect(addressBlockReason('::ffff:10.0.0.1', PROD)).toBe('private');
    expect(addressBlockReason('not-an-ip', PROD)).toBe('invalid');
    expect(addressBlockReason('1.2.3.4', PROD)).toBeNull();
    expect(unmapIpv4('::ffff:a00:1')).toBe('10.0.0.1');
    expect(unmapIpv4('2001:db8::1')).toBe('2001:db8::1');
  });
});

// ── Executor (local stub; "public" names resolved by a fake resolver) ─────

const stub = useStubServer();
const KEY = randomBytes(32);
const PUBLIC_IP = '1.2.3.4';

const fn = (over: Partial<AgentFunction> = {}): AgentFunction =>
  ({
    name: 'lookup',
    description: 'Look up',
    parameters: [],
    method: 'GET',
    url: `http://api.public.test:${stub.port}/status`,
    headers: [],
    bodyTemplate: null,
    resultPath: null,
    responseHint: null,
    timeoutMs: 3000,
    ...over,
  }) as AgentFunction;

const ctx = (args: Record<string, unknown> = {}) => ({
  args,
  contact: { phone: '+919000000001', name: 'Asha Verma', loan_id: 'L/1 2' },
  agentName: 'Recovery',
  company: 'Acme Finance',
});

const DNS: Record<string, string[]> = {
  'api.public.test': [PUBLIC_IP],
  'other.public.test': ['5.6.7.8'],
  'internal.test': ['10.0.0.7'],
  'mixed.test': [PUBLIC_IP, '10.0.0.1'],
  'meta.test': ['169.254.169.254'],
};

/** Production-like rules (no private hosts); fake public IPs are dialled to the stub. */
const options = (policy: Partial<GuardPolicy> = {}): HttpToolOptions => ({
  policy: { httpsOnly: false, allowPrivate: false, extraPorts: [stub.port], ...policy },
  resolve: (host) => {
    const found = DNS[host];
    return found ? Promise.resolve(found) : Promise.reject(new Error('ENOTFOUND'));
  },
  dial: (ip) => (ip === PUBLIC_IP || ip === '5.6.7.8' ? '127.0.0.1' : ip),
});

beforeEach(() => stub.reset());

describe('executeFunction — SSRF', () => {
  it('calls a public host (pinned to the checked address)', async () => {
    stub.next(json(200, { status: 'paid' }));
    const out = await executeFunction(fn(), ctx(), KEY, options());
    expect(out).toMatchObject({ ok: true, httpStatus: 200, result: { status: 'paid' } });
    expect(stub.requests[0]?.headers.host).toBe(`api.public.test:${stub.port}`);
  });

  it.each([
    ['https only', 'http://api.public.test:PORT/x', { httpsOnly: true }],
    ['loopback literal', 'http://127.0.0.1:PORT/x', {}],
    ['name → private', 'http://internal.test:PORT/x', {}],
    ['mixed public + private', 'http://mixed.test:PORT/x', {}],
    ['metadata name (dev)', 'http://meta.test:PORT/x', { allowPrivate: true }],
    [
      'metadata literal (dev)',
      'http://169.254.169.254:PORT/latest/meta-data',
      { allowPrivate: true },
    ],
    ['port 22', 'http://api.public.test:22/x', {}],
  ])('%s → blocked, nothing sent', async (_label, url, policy) => {
    const target = url.replace('PORT', String(stub.port));
    const out = await executeFunction(fn({ url: target }), ctx(), KEY, options(policy));
    expect(out).toMatchObject({ ok: false, error: 'blocked', httpStatus: null });
    expect(stub.requests).toHaveLength(0);
  });

  it('dev mode reaches 127.0.0.1 directly', async () => {
    stub.next(json(200, { ok: 1 }));
    const out = await executeFunction(
      fn({ url: `${stub.url}/x` }),
      ctx(),
      KEY,
      options({ allowPrivate: true }),
    );
    expect(out.ok).toBe(true);
  });

  it('a redirect to a private address is blocked', async () => {
    stub.next((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${stub.port}/admin` }).end();
    });
    const out = await executeFunction(fn(), ctx(), KEY, options());
    expect(out).toMatchObject({ ok: false, error: 'blocked' });
    expect(stub.requests).toHaveLength(1);
  });

  it('follows ≤ 2 redirects; secrets stay on the same origin only', async () => {
    const secret = fn({
      headers: [
        {
          name: 'Authorization',
          secret: true,
          sealed: seal(KEY, 'Bearer s3cret-9876'),
          valueHint: '••••9876',
        },
      ],
    });
    stub.next(
      (_req, res) => res.writeHead(301, { location: '/moved' }).end(),
      (_req, res) =>
        res.writeHead(307, { location: `http://other.public.test:${stub.port}/final` }).end(),
      json(200, { done: true }),
    );
    const out = await executeFunction(secret, ctx(), KEY, options());
    expect(out).toMatchObject({ ok: true, result: { done: true } });
    expect(stub.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer s3cret-9876',
      'Bearer s3cret-9876',
      undefined,
    ]);
    stub.always((_req, res) => res.writeHead(302, { location: '/again' }).end());
    expect((await executeFunction(fn(), ctx(), KEY, options())).error).toBe('too_many_redirects');
  });

  it('unresolvable host → network error', async () => {
    const out = await executeFunction(
      fn({ url: 'http://nowhere.test:8080/x' }),
      ctx(),
      KEY,
      options(),
    );
    expect(out.error).toBe('network');
  });
});

describe('executeFunction — requests and responses', () => {
  it('GET with URL-encoded values from args and contact', async () => {
    stub.next(json(200, {}));
    await executeFunction(
      fn({
        url: `http://api.public.test:${stub.port}/loans/{{contact.loan_id}}?q={{args.q}}&phone={{contact.phone}}`,
        parameters: [{ name: 'q', type: 'string', description: '', required: true }],
      }),
      ctx({ q: 'a&b=c' }),
      KEY,
      options(),
    );
    expect(stub.requests[0]?.url).toBe('/loans/L%2F1%202?q=a%26b%3Dc&phone=%2B919000000001');
  });

  it('POST renders the JSON tree (typed leaves, escaped strings) with plain + secret headers', async () => {
    stub.next(json(200, { saved: true }));
    const out = await executeFunction(
      fn({
        method: 'POST',
        bodyTemplate: JSON.stringify({
          amount: '{{args.amount}}',
          note: 'Paid by {{contact.name}} "{{args.note}}"',
          urgent: '{{args.urgent}}',
          nested: [{ who: '{{agent.name}}', co: '{{company}}' }],
          missing: '{{args.none}}',
        }),
        headers: [
          { name: 'X-Plain', secret: false, value: 'co-{{company}}' },
          {
            name: 'X-Key',
            secret: true,
            sealed: seal(KEY, 'top-secret-1234'),
            valueHint: '••••1234',
          },
        ],
      }),
      ctx({ amount: 500, note: 'x"}', urgent: true }),
      KEY,
      options(),
    );
    const req = stub.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers['x-plain']).toBe('co-Acme Finance');
    expect(req?.headers['x-key']).toBe('top-secret-1234');
    expect(JSON.parse(req?.body ?? '')).toEqual({
      amount: 500,
      note: 'Paid by Asha Verma "x"}"',
      urgent: true,
      nested: [{ who: 'Recovery', co: 'Acme Finance' }],
      missing: '',
    });
    expect(out.warnings).toEqual(['missing:args.none']);
    expect(JSON.stringify(out)).not.toContain('top-secret');
  });

  it('refuses CR / LF injected through a header template', async () => {
    const out = await executeFunction(
      fn({ headers: [{ name: 'X-Who', secret: false, value: '{{args.who}}' }] }),
      ctx({ who: 'a\r\nX-Evil: 1' }),
      KEY,
      options(),
    );
    expect(out.error).toBe('invalid_request');
    expect(stub.requests).toHaveLength(0);
  });

  it('a secret sealed with another key is unavailable', async () => {
    const out = await executeFunction(
      fn({
        headers: [
          { name: 'X-Key', secret: true, sealed: seal(randomBytes(32), 'x'), valueHint: null },
        ],
      }),
      ctx(),
      KEY,
      options(),
    );
    expect(out.error).toBe('secret_unavailable');
  });

  it('extracts resultPath; a miss gives null + warning', async () => {
    const payload = { data: { items: [{ status: 'unpaid' }] } };
    stub.next(json(200, payload), json(200, payload));
    const hit = await executeFunction(
      fn({ resultPath: 'data.items.0.status' }),
      ctx(),
      KEY,
      options(),
    );
    expect(hit).toMatchObject({ ok: true, result: 'unpaid', resultText: 'unpaid' });
    const miss = await executeFunction(
      fn({ resultPath: 'data.items.3.status' }),
      ctx(),
      KEY,
      options(),
    );
    expect(miss).toMatchObject({ ok: true, result: null, warnings: ['result_path_not_found'] });
  });

  it('plain text, invalid JSON, HTTP errors', async () => {
    stub.next(
      (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('all good'),
      (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{bad'),
      json(404, { error: 'nope' }),
    );
    expect((await executeFunction(fn(), ctx(), KEY, options())).result).toBe('all good');
    expect((await executeFunction(fn(), ctx(), KEY, options())).error).toBe('invalid_json');
    expect(await executeFunction(fn(), ctx(), KEY, options())).toMatchObject({
      ok: false,
      error: 'http_404',
      httpStatus: 404,
    });
  });

  it('cuts responses over 64 KB and truncates long results to 2,000 chars', async () => {
    stub.next(
      (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(70_000)),
      (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('y'.repeat(5_000)),
    );
    expect((await executeFunction(fn(), ctx(), KEY, options())).error).toBe('too_large');
    const long = await executeFunction(fn(), ctx(), KEY, options());
    expect(long.resultText).toHaveLength(2000);
    expect(long.bytes).toBe(5000);
  });

  it('times out', async () => {
    stub.next(() => undefined); // never answers
    const out = await executeFunction(fn({ timeoutMs: 1000 }), ctx(), KEY, options());
    expect(out).toMatchObject({ ok: false, error: 'timeout' });
    expect(out.durationMs).toBeGreaterThanOrEqual(900);
  });
});
