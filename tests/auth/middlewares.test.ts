import { randomBytes } from 'node:crypto';

import express, { json, Router } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import { AccountModel } from '../../src/db/models/account.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { UserModel } from '../../src/db/models/user.model';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { requireAuth } from '../../src/shared/auth/auth-context';
import { accountScope, findOwnedOr404, tenantFilter } from '../../src/shared/auth/tenant';
import { ok } from '../../src/shared/http/envelope';
import { createLogger } from '../../src/shared/logger';
import { apiKeyAuth } from '../../src/shared/middlewares/api-key-auth';
import { authenticate, bearerToken } from '../../src/shared/middlewares/authenticate';
import { errorHandler } from '../../src/shared/middlewares/error-handler';
import { httpLogger } from '../../src/shared/middlewares/http-logger';
import { originCheck } from '../../src/shared/middlewares/origin-check';
import { requestId } from '../../src/shared/middlewares/request-id';
import {
  blockWhenImpersonating,
  requireAnyPermission,
  requirePermission,
  requirePlatformAdmin,
} from '../../src/shared/middlewares/require-permission';
import { createTestAccount, tokenFor } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { testEnv } from '../helpers/test-app';

useTestDb();

const buildApp = () => {
  const app = express();
  app.use(requestId());
  app.use(httpLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })));
  app.use(json());
  const r = Router();
  r.all('/me', authenticate(), (req, res) => {
    const auth = requireAuth(req);
    ok(res, { ...auth, permissions: [...auth.permissions].sort() });
  });
  r.get('/team', authenticate(), requirePermission('team.read'), (_req, res) => ok(res, 'team'));
  r.get(
    '/either',
    authenticate(),
    requireAnyPermission('apikeys.manage', 'calls.read'),
    (_req, res) => ok(res, 'either'),
  );
  r.get('/admin', authenticate(), requirePlatformAdmin(), (_req, res) => ok(res, 'admin'));
  r.post('/sensitive', authenticate(), blockWhenImpersonating(), (_req, res) => ok(res, 'done'));
  r.get('/users/:id', authenticate(), async (req, res) => {
    const user = await findOwnedOr404(UserModel, String(req.params.id), req, { email: 1 });
    ok(res, {
      email: user.email,
      filter: tenantFilter(req).accountId.toString(),
      scope: accountScope(req),
    });
  });
  r.get('/no-auth', (req, res) => ok(res, requireAuth(req)));
  r.all('/key', apiKeyAuth(), (req, res) =>
    ok(res, { accountId: req.auth?.accountId, kind: req.auth?.kind }),
  );
  r.get('/key/calls', apiKeyAuth({ scopes: ['calls:write'] }), (_req, res) => ok(res, 'calls'));
  r.post('/origin', originCheck(testEnv({ CORS_ORIGINS: 'http://localhost:3100' })), (_req, res) =>
    ok(res, 'ok'),
  );
  r.post(
    '/origin-prod',
    originCheck({ NODE_ENV: 'production', CORS_ORIGINS: ['https://app.example.com'] }),
    (_req, res) => ok(res, 'ok'),
  );
  app.use(r);
  app.use(errorHandler());
  return app;
};

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('bearerToken', () => {
  it('parses only well-formed Bearer headers', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('authenticate', () => {
  it('sets the auth context from the token and the database', async () => {
    const t = await createTestAccount();
    const { user, token } = await t.addUser('manager');
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      kind: 'user',
      accountId: t.account._id.toString(),
      userId: user._id.toString(),
      roleKey: 'manager',
      tokenVersion: 0,
      account: { status: 'active', timezone: 'Asia/Kolkata', isPlatform: false },
    });
    expect(res.body.data.permissions).toContain('team.read');
    expect(res.body.data.permissions).not.toContain('team.invite');
    expect(res.body.data.platformRole).toBeUndefined();
  });

  it.each([
    ['no header', {}],
    ['malformed header', { Authorization: 'Token abc' }],
    ['garbage token', { Authorization: 'Bearer not.a.jwt' }],
  ])('rejects %s with 401', async (_name, headers) => {
    const res = await request(app).get('/me').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_UNAUTHENTICATED');
  });

  it('rejects an expired token with AUTH_TOKEN_EXPIRED', async () => {
    const t = await createTestAccount();
    const { user } = await t.addUser('viewer');
    const token = await tokenFor(user, { ttl: '-1m' });
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('rejects a token after tokenVersion changed', async () => {
    const t = await createTestAccount();
    const { user, token } = await t.addUser('viewer');
    await UserModel.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(401);
  });

  it('rejects disabled, invited, unverified, deleted and moved users', async () => {
    const t = await createTestAccount();
    const disabled = await t.addUser('viewer', { status: 'disabled' });
    expect((await request(app).get('/me').set(bearer(disabled.token))).body.error.code).toBe(
      'AUTH_USER_DISABLED',
    );
    const invited = await t.addUser('viewer', { status: 'invited' });
    expect((await request(app).get('/me').set(bearer(invited.token))).body.error.code).toBe(
      'AUTH_UNAUTHENTICATED',
    );
    const unverified = await t.addUser('viewer', { emailVerifiedAt: null });
    expect((await request(app).get('/me').set(bearer(unverified.token))).body.error.code).toBe(
      'AUTH_EMAIL_NOT_VERIFIED',
    );
    const deleted = await t.addUser('viewer');
    await UserModel.updateOne({ _id: deleted.user._id }, { $set: { deletedAt: new Date() } });
    expect((await request(app).get('/me').set(bearer(deleted.token))).status).toBe(401);
    const other = await createTestAccount();
    const moved = await t.addUser('viewer');
    await UserModel.updateOne({ _id: moved.user._id }, { $set: { accountId: other.account._id } });
    expect((await request(app).get('/me').set(bearer(moved.token))).status).toBe(401);
  });

  it('allows reads but blocks writes on a suspended account', async () => {
    const t = await createTestAccount({ status: 'suspended' });
    const { token } = await t.addUser('owner');
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(200);
    const res = await request(app).post('/me').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('gives superadmins the platform permissions (not while impersonating)', async () => {
    const platform = await createTestAccount({ isPlatform: true });
    const admin = await platform.addUser('owner', { platformRole: 'superadmin' });
    const me = await request(app).get('/me').set(bearer(admin.token));
    expect(me.body.data.platformRole).toBe('superadmin');
    expect(me.body.data.permissions).toContain('platform.impersonate');
    expect((await request(app).get('/admin').set(bearer(admin.token))).status).toBe(200);

    const target = await createTestAccount();
    const owner = await target.addUser('owner');
    const impToken = await tokenFor(owner.user, { sid: 'imp_x', imp: admin.user._id.toString() });
    const imp = await request(app).get('/me').set(bearer(impToken));
    expect(imp.body.data.impersonatorId).toBe(admin.user._id.toString());
    expect(imp.body.data.permissions).not.toContain('platform.impersonate');
    expect((await request(app).get('/admin').set(bearer(impToken))).status).toBe(403);
    const blocked = await request(app).post('/sensitive').set(bearer(impToken));
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await request(app).post('/sensitive').set(bearer(owner.token))).status).toBe(200);
  });

  it('answers 401 for requireAuth without authenticate', async () => {
    expect((await request(app).get('/no-auth')).status).toBe(401);
  });
});

describe('permission guards', () => {
  it('requirePermission allows and denies by role', async () => {
    const t = await createTestAccount();
    const manager = await t.addUser('manager');
    const agent = await t.addUser('agent');
    expect((await request(app).get('/team').set(bearer(manager.token))).status).toBe(200);
    const denied = await request(app).get('/team').set(bearer(agent.token));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('requireAnyPermission passes with one of the permissions', async () => {
    const t = await createTestAccount();
    const viewer = await t.addUser('viewer');
    expect((await request(app).get('/either').set(bearer(viewer.token))).status).toBe(200);
  });

  it('requirePlatformAdmin rejects account owners', async () => {
    const t = await createTestAccount();
    const owner = await t.addUser('owner');
    expect((await request(app).get('/admin').set(bearer(owner.token))).status).toBe(403);
  });
});

describe('tenant helpers', () => {
  it('finds documents of the own account and 404s for others or bad ids', async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const ownerA = await a.addUser('owner');
    const memberA = await a.addUser('viewer');
    const memberB = await b.addUser('viewer');
    const own = await request(app)
      .get(`/users/${memberA.user._id.toString()}`)
      .set(bearer(ownerA.token));
    expect(own.status).toBe(200);
    expect(own.body.data).toEqual({
      email: memberA.user.email,
      filter: a.account._id.toString(),
      scope: a.account._id.toString(),
    });
    expect(
      (await request(app).get(`/users/${memberB.user._id.toString()}`).set(bearer(ownerA.token)))
        .status,
    ).toBe(404);
    expect((await request(app).get('/users/not-an-id').set(bearer(ownerA.token))).status).toBe(404);
  });
});

describe('apiKeyAuth', () => {
  const makeKey = async (accountId: Types.ObjectId, scopes: string[], extra = {}) => {
    const raw = `cav_test_${randomBytes(24)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 32)
      .padEnd(32, 'a')}`;
    const doc = await ApiKeyModel.create({
      accountId,
      name: 'k',
      prefix: raw.slice(0, 13),
      keyHash: sha256Hex(raw),
      scopes,
      createdBy: new Types.ObjectId(),
      ...extra,
    });
    return { raw, doc };
  };

  it('authenticates a valid key and checks scopes', async () => {
    const t = await createTestAccount();
    const { raw } = await makeKey(t.account._id, ['calls:read']);
    const res = await request(app).get('/key').set('X-API-Key', raw);
    expect(res.body.data).toEqual({ accountId: t.account._id.toString(), kind: 'api_key' });
    const scoped = await request(app).get('/key/calls').set('X-API-Key', raw);
    expect(scoped.status).toBe(403);
  });

  it('rejects malformed, unknown and revoked keys', async () => {
    const t = await createTestAccount();
    const { raw } = await makeKey(t.account._id, [], { revokedAt: new Date() });
    for (const key of ['nope', 'cav_live_' + 'x'.repeat(32), raw]) {
      expect((await request(app).get('/key').set('X-API-Key', key)).status).toBe(401);
    }
    expect((await request(app).get('/key')).status).toBe(401);
  });

  it('blocks writes on suspended accounts', async () => {
    const t = await createTestAccount({ status: 'suspended' });
    const { raw } = await makeKey(t.account._id, []);
    expect((await request(app).get('/key').set('X-API-Key', raw)).status).toBe(200);
    expect((await request(app).post('/key').set('X-API-Key', raw)).body.error.code).toBe(
      'AUTH_ACCOUNT_SUSPENDED',
    );
  });

  it('updates lastUsedAt at most once a minute', async () => {
    const t = await createTestAccount();
    const { raw, doc } = await makeKey(t.account._id, []);
    await request(app).get('/key').set('X-API-Key', raw);
    await new Promise((r) => setTimeout(r, 50));
    const first = (await ApiKeyModel.findById(doc._id).lean())?.lastUsedAt;
    expect(first).toBeInstanceOf(Date);
    await request(app).get('/key').set('X-API-Key', raw);
    await new Promise((r) => setTimeout(r, 50));
    expect((await ApiKeyModel.findById(doc._id).lean())?.lastUsedAt?.getTime()).toBe(
      first?.getTime(),
    );
  });

  it('ignores keys of deleted accounts', async () => {
    const accountId = new Types.ObjectId();
    const { raw } = await makeKey(accountId, []);
    expect(await AccountModel.exists({ _id: accountId })).toBeNull();
    expect((await request(app).get('/key').set('X-API-Key', raw)).status).toBe(401);
  });
});

describe('originCheck', () => {
  it('allows listed or missing origins outside production, rejects others', async () => {
    expect((await request(app).post('/origin').set('Origin', 'http://localhost:3100')).status).toBe(
      200,
    );
    expect((await request(app).post('/origin')).status).toBe(200);
    expect((await request(app).post('/origin').set('Origin', 'https://evil.example')).status).toBe(
      403,
    );
  });

  it('requires an origin in production', async () => {
    expect((await request(app).post('/origin-prod')).status).toBe(403);
    expect(
      (await request(app).post('/origin-prod').set('Origin', 'https://app.example.com')).status,
    ).toBe(200);
  });
});

describe('GET /api/v1/rbac/permissions', () => {
  it('returns the catalogue and roles to signed-in users only', async () => {
    const env = testEnv();
    const real = createApp({ env, logger: createLogger(env) });
    expect((await request(real).get('/api/v1/rbac/permissions')).status).toBe(401);
    const t = await createTestAccount();
    const { token } = await t.addUser('viewer');
    const res = await request(real).get('/api/v1/rbac/permissions').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r: { key: string }) => r.key)).toEqual([
      'owner',
      'admin',
      'manager',
      'agent',
      'viewer',
    ]);
    expect(res.body.data.permissions[0]).toEqual({
      key: 'account.read',
      group: 'Account',
      description: expect.any(String),
    });
  });
});
