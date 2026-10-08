import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { generateApiKey, MAX_ACTIVE_KEYS } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { API_KEY_FORMAT } from '../../src/shared/middlewares/api-key-auth';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let t: TestAccount;
let admin: TestUser;

beforeAll(async () => {
  t = await createTestAccount();
  await t.addUser('owner');
  admin = await t.addUser('admin');
});

const create = (token: string, body: object) =>
  request(app).post('/api/v1/api-keys').set(auth(token)).send(body);

describe('generateApiKey', () => {
  it('produces cav_test_/cav_live_ + 32 base62 chars, unique', () => {
    const a = generateApiKey(false);
    expect(a).toMatch(API_KEY_FORMAT);
    expect(a.startsWith('cav_test_')).toBe(true);
    expect(generateApiKey(true).startsWith('cav_live_')).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => generateApiKey(false))).size).toBe(200);
  });
});

describe('API keys', () => {
  it('creates a key shown once, stores only the hash, and the key works on whoami', async () => {
    const res = await create(admin.token, {
      name: 'CRM sync',
      scopes: ['calls:write', 'contacts:read'],
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { key, apiKey } = res.body.data as {
      key: string;
      apiKey: { id: string; prefix: string };
    };
    expect(key).toMatch(API_KEY_FORMAT);
    expect(apiKey.prefix).toBe(key.slice(0, 13));
    const stored = await ApiKeyModel.findById(apiKey.id).lean();
    expect(stored?.keyHash).toBe(sha256Hex(key));
    expect(JSON.stringify(stored)).not.toContain(key);

    const who = await request(app).get('/api/v1/api-keys/whoami').set('X-API-Key', key);
    expect(who.body.data).toEqual({
      accountId: t.account._id.toString(),
      apiKeyId: apiKey.id,
      scopes: ['calls:write', 'contacts:read'],
    });

    const list = await request(app).get('/api/v1/api-keys').set(auth(admin.token));
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(JSON.stringify(list.body)).not.toContain('keyHash');
    expect(list.body.data[0]).toMatchObject({ id: apiKey.id, name: 'CRM sync', revokedAt: null });
    expect(
      await AuditLogModel.countDocuments({ accountId: t.account._id, action: 'apikey.created' }),
    ).toBeGreaterThan(0);
  });

  it('revokes (idempotent): the key stops working', async () => {
    const res = await create(admin.token, { name: 'Temp', scopes: ['calls:read'] });
    const { key, apiKey } = res.body.data as { key: string; apiKey: { id: string } };
    expect(
      (await request(app).delete(`/api/v1/api-keys/${apiKey.id}`).set(auth(admin.token))).status,
    ).toBe(204);
    expect(
      (await request(app).delete(`/api/v1/api-keys/${apiKey.id}`).set(auth(admin.token))).status,
    ).toBe(204);
    expect((await request(app).get('/api/v1/api-keys/whoami').set('X-API-Key', key)).status).toBe(
      401,
    );
    expect(
      await AuditLogModel.countDocuments({ action: 'apikey.revoked', 'target.id': apiKey.id }),
    ).toBe(1);
  });

  it.each([
    ['no scopes', { name: 'x', scopes: [] }],
    ['unknown scope', { name: 'x', scopes: ['root:all'] }],
    ['duplicate scopes', { name: 'x', scopes: ['calls:read', 'calls:read'] }],
    ['empty name', { name: '', scopes: ['calls:read'] }],
  ])('rejects %s', async (_n, body) => {
    expect((await create(admin.token, body)).status).toBe(422);
  });

  it('allows at most 20 active keys', async () => {
    const x = await createTestAccount();
    const o = await x.addUser('owner');
    for (let i = 0; i < MAX_ACTIVE_KEYS; i += 1) {
      await ApiKeyModel.create({
        accountId: x.account._id,
        name: `k${i}`,
        prefix: 'p',
        keyHash: `${i}`.padStart(64, '0'),
        scopes: [],
        createdBy: o.user._id,
      });
    }
    expect((await create(o.token, { name: 'one too many', scopes: ['calls:read'] })).status).toBe(
      409,
    );
  });

  it('enforces permissions, isolation and the impersonation block', async () => {
    const manager = await t.addUser('manager');
    expect((await request(app).get('/api/v1/api-keys').set(auth(manager.token))).status).toBe(403);
    expect((await create(manager.token, { name: 'x', scopes: ['calls:read'] })).status).toBe(403);
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    const res = await create(admin.token, { name: 'Mine', scopes: ['calls:read'] });
    const id = String(res.body.data.apiKey.id);
    expect(
      (await request(app).delete(`/api/v1/api-keys/${id}`).set(auth(otherOwner.token))).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/v1/api-keys').set(auth(otherOwner.token))).body.data,
    ).toEqual([]);
    const imp = await tokenFor(admin.user, { sid: 'imp_k', imp: admin.user._id.toString() });
    expect((await create(imp, { name: 'x', scopes: ['calls:read'] })).body.error.code).toBe(
      'AUTH_IMPERSONATION_BLOCKED',
    );
  });
});
