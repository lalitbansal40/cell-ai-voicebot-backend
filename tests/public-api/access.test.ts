import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PUBLIC_API_LIMITS } from '../../src/config/limits';
import { AccountModel } from '../../src/db/models/account.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { ApiRequestLogModel } from '../../src/db/models/api-request-log.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { generateApiKey } from '../../src/modules/api-keys/api-keys.service';
import {
  API_KEY_SCOPES,
  permissionsForScopes,
  SCOPE_PERMISSIONS,
  type ApiKeyScope,
} from '../../src/modules/api-keys/scopes';
import { sha256Hex } from '../../src/modules/auth/hmac';
import type { CallManager } from '../../src/modules/calls/call.service';
import type { CallRegistry } from '../../src/modules/calls/registry';
import { flushApiKeyUsage } from '../../src/modules/public-api/request-log';
import { PERMISSIONS } from '../../src/modules/rbac/permissions';
import {
  invalidateApiKeyCache,
  ipAllowed,
  normalizeIp,
  parseCidr,
} from '../../src/shared/middlewares/api-key-auth';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();

// the calls router needs a voice runtime; access is decided before any of it is used
const calls = {
  manager: {} as CallManager,
  registry: { liveCalls: () => Promise.resolve([]) } as unknown as CallRegistry,
  textInput: false,
  voiceProvider: 'fake' as const,
};
const app = buildTestApp({}, { calls });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let a: TestAccount;
let owner: TestUser;
let viewer: TestUser;

/** A key stored like `createApiKey` does (the raw key is returned). */
const makeKey = async (
  account: TestAccount,
  scopes: string[],
  extra: { ipAllowlist?: string[]; expiresAt?: Date | null; revokedAt?: Date | null } = {},
) => {
  const key = generateApiKey(false);
  const doc = await ApiKeyModel.create({
    accountId: account.account._id,
    name: 'test',
    prefix: key.slice(0, 13),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: owner.user._id,
    ...extra,
  });
  return { key, id: doc._id.toString() };
};

beforeAll(async () => {
  a = await createTestAccount();
  owner = await a.addUser('owner');
  viewer = await a.addUser('viewer');
  await ApiRequestLogModel.createIndexes();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const oid = () => new Types.ObjectId().toString();

/** Every key-enabled route of T15.1 with its scope; a body that passes auth (validation may still fail). */
const ROUTES: {
  method: 'get' | 'post' | 'patch';
  path: string;
  scope: ApiKeyScope;
  body?: object;
}[] = [
  { method: 'get', path: '/api/v1/contacts', scope: 'contacts:read' },
  { method: 'get', path: `/api/v1/contacts/${oid()}`, scope: 'contacts:read' },
  { method: 'post', path: '/api/v1/contacts', scope: 'contacts:write', body: {} },
  { method: 'patch', path: `/api/v1/contacts/${oid()}`, scope: 'contacts:write', body: {} },
  { method: 'post', path: '/api/v1/calls', scope: 'calls:write', body: {} },
  { method: 'get', path: '/api/v1/calls', scope: 'calls:read' },
  { method: 'get', path: `/api/v1/calls/${oid()}`, scope: 'calls:read' },
  { method: 'get', path: `/api/v1/calls/${oid()}/transcript`, scope: 'calls:read' },
  { method: 'get', path: `/api/v1/calls/${oid()}/insights`, scope: 'calls:read' },
  { method: 'get', path: '/api/v1/campaigns', scope: 'campaigns:read' },
  { method: 'get', path: `/api/v1/campaigns/${oid()}`, scope: 'campaigns:read' },
  { method: 'get', path: `/api/v1/campaigns/${oid()}/contacts`, scope: 'campaigns:read' },
  { method: 'get', path: `/api/v1/campaigns/${oid()}/runs`, scope: 'campaigns:read' },
  { method: 'post', path: '/api/v1/campaigns', scope: 'campaigns:write', body: {} },
  { method: 'post', path: `/api/v1/campaigns/${oid()}/start`, scope: 'campaigns:write' },
  { method: 'post', path: `/api/v1/campaigns/${oid()}/pause`, scope: 'campaigns:write' },
  { method: 'post', path: `/api/v1/campaigns/${oid()}/resume`, scope: 'campaigns:write' },
  {
    method: 'post',
    path: `/api/v1/campaigns/${oid()}/cancel`,
    scope: 'campaigns:write',
    body: {},
  },
  { method: 'get', path: '/api/v1/reports/overview', scope: 'reports:read' },
  { method: 'post', path: '/api/v1/exports/calls', scope: 'exports:write', body: {} },
  { method: 'post', path: '/api/v1/exports/messages', scope: 'exports:write', body: {} },
  { method: 'post', path: '/api/v1/exports/report', scope: 'exports:write', body: {} },
  { method: 'get', path: `/api/v1/exports/${oid()}`, scope: 'exports:write' },
];

const send = (route: (typeof ROUTES)[number], headers: Record<string, string>) => {
  const r = request(app)[route.method](route.path).set(headers);
  return route.body ? r.send(route.body) : r;
};

describe('scopes', () => {
  it('has 13 scopes in 6 groups, each mapped to real permissions', () => {
    expect(API_KEY_SCOPES).toHaveLength(13);
    expect(API_KEY_SCOPES).toEqual(
      expect.arrayContaining([
        'messages:read',
        'messages:write',
        'templates:read',
        'whatsapp-calls:write',
        'reports:read',
        'exports:write',
      ]),
    );
    const known = new Set<string>(PERMISSIONS);
    for (const scope of API_KEY_SCOPES) {
      expect(SCOPE_PERMISSIONS[scope].length).toBeGreaterThan(0);
      for (const p of SCOPE_PERMISSIONS[scope]) expect(known.has(p)).toBe(true);
    }
    // keys never export phone numbers
    expect(permissionsForScopes(API_KEY_SCOPES).has('contacts.export')).toBe(false);
    expect(permissionsForScopes(['nope'])).toEqual(new Set());
  });

  it('lists the catalogue with groups for the dashboard', async () => {
    const res = await request(app).get('/api/v1/api-keys/scopes').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(13);
    expect(new Set(res.body.data.map((s: { group: string }) => s.group))).toEqual(
      new Set(['Calls', 'Contacts', 'Campaigns', 'WhatsApp', 'Reports', 'Webhooks']),
    );
  });
});

describe('access() — one route, two auths', () => {
  it.each(ROUTES)('$method $path', async (route) => {
    const withScope = await makeKey(a, [route.scope]);
    const other = API_KEY_SCOPES.find((s) => s !== route.scope) as ApiKeyScope;
    const without = await makeKey(a, [other]);

    const anon = await send(route, {});
    expect(anon.status).toBe(401);

    const keyOk = await send(route, { 'X-API-Key': withScope.key });
    expect([401, 403]).not.toContain(keyOk.status);

    const keyNo = await send(route, { 'X-API-Key': without.key });
    expect(keyNo.status).toBe(403);
    expect(keyNo.body.error.code).toBe('AUTH_FORBIDDEN');
    expect(keyNo.body.error.details).toEqual([
      { path: 'scope', message: `${route.scope} is required` },
    ]);

    const session = await send(route, bearer(owner.token));
    expect([401, 403]).not.toContain(session.status);
  });

  it('keeps permissions for sessions (viewer cannot write)', async () => {
    expect(
      (await request(app).post('/api/v1/contacts').set(bearer(viewer.token)).send({})).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/contacts').set(bearer(viewer.token))).status).toBe(200);
  });

  it('never lets a key through a session-only route, even with every scope', async () => {
    const { key } = await makeKey(a, [...API_KEY_SCOPES]);
    // session-only router: no key auth at all
    expect((await request(app).get('/api/v1/team/members').set('X-API-Key', key)).status).toBe(401);
    expect((await request(app).get('/api/v1/wallet').set('X-API-Key', key)).status).toBe(401);
    // session-only route inside a router that accepts keys
    expect((await request(app).get('/api/v1/calls/active').set('X-API-Key', key)).status).toBe(403);
    expect(
      (await request(app).post('/api/v1/contacts/search').set('X-API-Key', key).send({})).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/campaigns/summary').set('X-API-Key', key)).status).toBe(
      403,
    );
    expect((await request(app).get('/api/v1/exports').set('X-API-Key', key)).status).toBe(403);
    // a session token wins over a key header
    expect(
      (
        await request(app)
          .get('/api/v1/calls/active')
          .set('X-API-Key', key)
          .set(bearer(owner.token))
      ).status,
    ).toBe(200);
  });

  it('isolates accounts: a key only sees its own records', async () => {
    const b = await createTestAccount();
    await b.addUser('owner');
    const theirs = await ContactModel.create({
      accountId: b.account._id,
      name: 'Other',
      phoneE164: '+919800000001',
      source: { type: 'manual' },
    });
    const { key } = await makeKey(a, ['contacts:read']);
    const res = await request(app)
      .get(`/api/v1/contacts/${theirs._id.toString()}`)
      .set('X-API-Key', key);
    expect(res.status).toBe(404);
    const list = await request(app).get('/api/v1/contacts').set('X-API-Key', key);
    expect(JSON.stringify(list.body)).not.toContain(theirs._id.toString());
  });

  it('records contacts created by a key as source "api"', async () => {
    const { key } = await makeKey(a, ['contacts:write']);
    const res = await request(app)
      .post('/api/v1/contacts')
      .set('X-API-Key', key)
      .send({ name: 'From API', phone: '+919811112222' });
    expect(res.status).toBe(201);
    const stored = await ContactModel.findById(res.body.data.id).lean();
    expect(stored?.source.type).toBe('api');
  });
});

describe('key checks', () => {
  it('revocation works at once on this instance', async () => {
    const { key, id } = await makeKey(a, ['contacts:read']);
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(200);
    const del = await request(app).delete(`/api/v1/api-keys/${id}`).set(bearer(owner.token));
    expect(del.status).toBe(204);
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(401);
  });

  it('other instances drop a changed key within 30 s (cache TTL)', async () => {
    const { key, id } = await makeKey(a, ['contacts:read']);
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(200);
    // another instance revoked it: this process still has the cached entry
    await ApiKeyModel.updateOne({ _id: id }, { $set: { revokedAt: new Date() } });
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(200);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + (PUBLIC_API_LIMITS.keyCacheSec + 1) * 1000);
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(401);
  });

  it('rejects malformed, unknown and expired keys', async () => {
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', 'nope')).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/contacts').set('X-API-Key', generateApiKey(false))).status,
    ).toBe(401);
    const { key } = await makeKey(a, ['contacts:read'], {
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(app).get('/api/v1/contacts').set('X-API-Key', key);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_KEY_EXPIRED');
    const later = await makeKey(a, ['contacts:read'], {
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', later.key)).status).toBe(
      200,
    );
  });

  it('applies the IP allowlist to req.ip (X-Forwarded-For only per TRUST_PROXY)', async () => {
    const denied = await makeKey(a, ['contacts:read'], { ipAllowlist: ['10.0.0.0/8'] });
    const res = await request(app).get('/api/v1/contacts').set('X-API-Key', denied.key);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_KEY_IP_DENIED');
    // spoofed header is ignored without a trusted proxy
    expect(
      (
        await request(app)
          .get('/api/v1/contacts')
          .set('X-API-Key', denied.key)
          .set('X-Forwarded-For', '10.1.2.3')
      ).status,
    ).toBe(403);
    // behind a trusted proxy the forwarded address counts
    const proxied = buildTestApp({ TRUST_PROXY: 'loopback' }, { calls });
    expect(
      (
        await request(proxied)
          .get('/api/v1/contacts')
          .set('X-API-Key', denied.key)
          .set('X-Forwarded-For', '10.1.2.3')
      ).status,
    ).toBe(200);
    const local = await makeKey(a, ['contacts:read'], {
      ipAllowlist: ['127.0.0.1/32', '::1/128'],
    });
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', local.key)).status).toBe(
      200,
    );
  });

  it('keeps a suspended account read-only for keys', async () => {
    const s = await createTestAccount();
    await s.addUser('owner');
    const { key } = await makeKey(s, ['contacts:read', 'contacts:write']);
    await AccountModel.updateOne({ _id: s.account._id }, { $set: { status: 'suspended' } });
    invalidateApiKeyCache();
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(200);
    const res = await request(app).post('/api/v1/contacts').set('X-API-Key', key).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });
});

describe('IP helpers', () => {
  it.each([
    ['203.0.113.7', true],
    ['203.0.113.0/24', true],
    ['2001:db8::/32', true],
    ['::1', true],
    ['10.0.0.0/33', false],
    ['2001:db8::/129', false],
    ['10.0.0.0/x', false],
    ['example.com', false],
    ['', false],
  ])('parseCidr(%s) → %s', (entry, valid) => {
    expect(parseCidr(entry) !== null).toBe(valid);
  });

  it('matches IPv4, IPv6 and IPv4-mapped addresses', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(ipAllowed([], undefined)).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], undefined)).toBe(false);
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:10.9.9.9')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '11.0.0.1')).toBe(false);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(ipAllowed(['2001:db8::/32'], '2001:db9::1')).toBe(false);
    expect(ipAllowed(['203.0.113.7'], '203.0.113.7')).toBe(true);
    expect(ipAllowed(['bad', '203.0.113.7'], 'garbage')).toBe(false);
  });
});

describe('per-key limits', () => {
  it('allows 60 writes a minute per key (429 + Retry-After), reads have their own bucket', async () => {
    const one = await makeKey(a, ['contacts:write', 'contacts:read']);
    const two = await makeKey(a, ['contacts:write']);
    for (let i = 0; i < PUBLIC_API_LIMITS.writesPerMinute; i += 1) {
      const r = await request(app).post('/api/v1/contacts').set('X-API-Key', one.key).send({});
      expect(r.status).toBe(422);
    }
    const over = await request(app).post('/api/v1/contacts').set('X-API-Key', one.key).send({});
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // reads and other keys are unaffected
    const read = await request(app).get('/api/v1/contacts').set('X-API-Key', one.key);
    expect(read.status).toBe(200);
    expect(read.headers['ratelimit-limit']).toBe(String(PUBLIC_API_LIMITS.readsPerMinute));
    expect(
      (await request(app).post('/api/v1/contacts').set('X-API-Key', two.key).send({})).status,
    ).toBe(422);
    // dashboard sessions keep the global limiter only
    expect(
      (await request(app).post('/api/v1/contacts').set(bearer(owner.token)).send({})).status,
    ).toBe(422);
  });
});

describe('request log and usage', () => {
  it('logs route templates only (no ids, query values or bodies) and counts usage per day', async () => {
    const { key, id } = await makeKey(a, ['calls:read', 'contacts:read']);
    const callId = oid();
    await request(app).get(`/api/v1/calls/${callId}`).set('X-API-Key', key);
    await request(app).get('/api/v1/contacts?q=secret-name').set('X-API-Key', key);
    await request(app).get('/api/v1/calls/active').set('X-API-Key', key);
    await vi.waitFor(async () => {
      expect(await ApiRequestLogModel.countDocuments({ apiKeyId: id })).toBe(3);
    });
    const rows = await ApiRequestLogModel.find({ apiKeyId: id }).sort({ _id: 1 }).lean();
    expect(rows.map((r) => [r.method, r.route, r.status])).toEqual([
      ['GET', '/api/v1/calls/:id', 404],
      ['GET', '/api/v1/contacts/', 200],
      ['GET', '/api/v1/calls/active', 403],
    ]);
    expect(JSON.stringify(rows)).not.toContain(callId);
    expect(JSON.stringify(rows)).not.toContain('secret-name');
    expect(rows[0]?.requestId).toMatch(/.+/);

    await flushApiKeyUsage();
    const stored = await ApiKeyModel.findById(id).lean();
    const today = new Date().toISOString().slice(0, 10);
    expect(stored?.usage).toEqual([{ day: today, reads: 3, writes: 0 }]);

    // more requests the same day add up; the dashboard shows 24 h / 7 d
    await request(app).post('/api/v1/contacts').set('X-API-Key', key).send({});
    await flushApiKeyUsage();
    expect((await ApiKeyModel.findById(id).lean())?.usage).toEqual([
      { day: today, reads: 3, writes: 1 },
    ]);
    const list = await request(app).get('/api/v1/api-keys').set(bearer(owner.token));
    const mine = (list.body.data as { id: string; requests24h: number; requests7d: number }[]).find(
      (k) => k.id === id,
    );
    await vi.waitFor(async () => {
      expect(await ApiRequestLogModel.countDocuments({ apiKeyId: id })).toBe(4);
    });
    expect(mine?.requests7d).toBe(4);
    expect(mine?.requests24h).toBeGreaterThanOrEqual(3);
  });

  it('keeps the last 7 days of counters', async () => {
    const { key, id } = await makeKey(a, ['contacts:read']);
    await ApiKeyModel.updateOne(
      { _id: id },
      {
        $set: {
          usage: Array.from({ length: 7 }, (_, i) => ({
            day: `2026-01-0${String(i + 1)}`,
            reads: 1,
            writes: 0,
          })),
        },
      },
    );
    await request(app).get('/api/v1/contacts').set('X-API-Key', key);
    await flushApiKeyUsage();
    const usage = (await ApiKeyModel.findById(id).lean())?.usage ?? [];
    expect(usage).toHaveLength(7);
    expect(usage[0]?.day).toBe('2026-01-02');
    expect(usage.at(-1)?.reads).toBe(1);
  });

  it('pages the request log by cursor (apikeys.read)', async () => {
    const { key, id } = await makeKey(a, ['contacts:read']);
    for (let i = 0; i < 3; i += 1) await request(app).get('/api/v1/contacts').set('X-API-Key', key);
    await vi.waitFor(async () => {
      expect(await ApiRequestLogModel.countDocuments({ apiKeyId: id })).toBe(3);
    });
    const first = await request(app)
      .get(`/api/v1/api-keys/${id}/requests?limit=2`)
      .set(bearer(owner.token));
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    const second = await request(app)
      .get(`/api/v1/api-keys/${id}/requests?limit=2&cursor=${String(first.body.data.nextCursor)}`)
      .set(bearer(owner.token));
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();
    expect(
      (await request(app).get(`/api/v1/api-keys/${oid()}/requests`).set(bearer(owner.token)))
        .status,
    ).toBe(404);
    const manager = await a.addUser('manager');
    expect(
      (await request(app).get(`/api/v1/api-keys/${id}/requests`).set(bearer(manager.token))).status,
    ).toBe(403);
  });
});

describe('PATCH /api-keys/:id', () => {
  it('changes name, scopes, allowlist and expiry — effective at once, audited', async () => {
    const { key, id } = await makeKey(a, ['contacts:read']);
    expect((await request(app).get('/api/v1/calls').set('X-API-Key', key)).status).toBe(403);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const res = await request(app)
      .patch(`/api/v1/api-keys/${id}`)
      .set(bearer(owner.token))
      .send({
        name: 'Renamed',
        scopes: ['calls:read'],
        ipAllowlist: ['127.0.0.1', '::1'],
        expiresAt,
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Renamed',
      scopes: ['calls:read'],
      ipAllowlist: ['127.0.0.1', '::1'],
      expiresAt,
    });
    expect((await request(app).get('/api/v1/calls').set('X-API-Key', key)).status).toBe(200);
    expect((await request(app).get('/api/v1/contacts').set('X-API-Key', key)).status).toBe(403);
    const audit = await AuditLogModel.findOne({ action: 'apikey.updated', 'target.id': id }).lean();
    expect(audit?.meta).toMatchObject({
      changed: ['name', 'scopes', 'ipAllowlist', 'expiresAt'],
      ipAllowlistCount: 2,
    });
    expect(JSON.stringify(audit)).not.toContain(key);

    const cleared = await request(app)
      .patch(`/api/v1/api-keys/${id}`)
      .set(bearer(owner.token))
      .send({ expiresAt: null, ipAllowlist: [] });
    expect(cleared.body.data).toMatchObject({ expiresAt: null, ipAllowlist: [] });
  });

  it.each([
    ['nothing', {}],
    ['a bad CIDR', { ipAllowlist: ['10.0.0.0/40'] }],
    [
      'too many entries',
      { ipAllowlist: Array.from({ length: 21 }, (_, i) => `10.0.0.${String(i)}`) },
    ],
    ['a past expiry', { expiresAt: '2020-01-01T00:00:00Z' }],
    ['an unknown scope', { scopes: ['root:all'] }],
    ['an unknown field', { keyHash: 'x' }],
  ])('rejects %s', async (_name, body) => {
    const { id } = await makeKey(a, ['contacts:read']);
    expect(
      (await request(app).patch(`/api/v1/api-keys/${id}`).set(bearer(owner.token)).send(body))
        .status,
    ).toBe(422);
  });

  it('refuses revoked keys, other accounts and missing permissions', async () => {
    const { id } = await makeKey(a, ['contacts:read'], { revokedAt: new Date() });
    expect(
      (
        await request(app)
          .patch(`/api/v1/api-keys/${id}`)
          .set(bearer(owner.token))
          .send({ name: 'x' })
      ).status,
    ).toBe(409);
    const b = await createTestAccount();
    const bo = await b.addUser('owner');
    const live = await makeKey(a, ['contacts:read']);
    expect(
      (
        await request(app)
          .patch(`/api/v1/api-keys/${live.id}`)
          .set(bearer(bo.token))
          .send({ name: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/v1/api-keys/${live.id}`)
          .set(bearer(viewer.token))
          .send({ name: 'x' })
      ).status,
    ).toBe(403);
  });

  it('creates keys with an allowlist and expiry', async () => {
    const fresh = await createTestAccount();
    const freshOwner = await fresh.addUser('owner');
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request(app)
      .post('/api/v1/api-keys')
      .set(bearer(freshOwner.token))
      .send({ name: 'LMS', scopes: ['calls:write'], ipAllowlist: ['203.0.113.0/24'], expiresAt });
    expect(res.status).toBe(201);
    expect(res.body.data.apiKey).toMatchObject({
      ipAllowlist: ['203.0.113.0/24'],
      expiresAt,
      requests24h: 0,
      requests7d: 0,
    });
  });
});

describe('externalRef', () => {
  it('filters calls by externalRef and shows it in the view', async () => {
    const contact = await ContactModel.create({
      accountId: a.account._id,
      name: 'Ref',
      phoneE164: '+919822223333',
      source: { type: 'manual' },
    });
    const base = {
      accountId: a.account._id,
      direction: 'outbound' as const,
      provider: 'dryrun' as const,
      from: 'dryrun',
      to: '+919822223333',
      status: 'completed' as const,
      isTest: true,
      charged: false,
      contactId: contact._id,
      source: { kind: 'agent' as const, agentId: new Types.ObjectId() },
      timestamps: { queuedAt: new Date() },
      metrics: emptyCallMetrics(),
      cost: emptyCallCost(),
    };
    const [mine] = await CallModel.create([
      { ...base, externalRef: 'loan-42' },
      { ...base, externalRef: 'loan-43' },
      base,
    ]);
    const { key } = await makeKey(a, ['calls:read']);
    const res = await request(app).get('/api/v1/calls?externalRef=loan-42').set('X-API-Key', key);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([mine?._id.toString()]);
    expect(res.body.data[0].externalRef).toBe('loan-42');
    expect(
      (
        await request(app)
          .get(`/api/v1/calls?externalRef=${'x'.repeat(PUBLIC_API_LIMITS.externalRefMax + 1)}`)
          .set('X-API-Key', key)
      ).status,
    ).toBe(422);
  });
});
