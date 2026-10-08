import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getEnv } from '../../src/config/env';
import { closeAllRedis, getAppRedis } from '../../src/core/queues/redis';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { RefreshTokenModel } from '../../src/db/models/refresh-token.model';
import { UserModel } from '../../src/db/models/user.model';
import { lockKey } from '../../src/modules/auth/lockout';
import { getLogger } from '../../src/shared/logger';
import { createTestAccount, TEST_PASSWORD, tokenFor, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { lastEmail, useCapturedEmail } from '../helpers/email';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });
const ORIGIN = 'http://localhost:3100';
let t: TestAccount;
const touchedEmails: string[] = [];

beforeAll(async () => {
  await requireRedis();
  t = await createTestAccount();
});

afterEach(async () => {
  const redis = getAppRedis(getEnv().REDIS_URL, getLogger());
  for (const email of touchedEmails.splice(0)) await redis.del(lockKey(email));
});

afterAll(async () => {
  await closeAllRedis();
});

const loginAs = (email: string, password = TEST_PASSWORD) => {
  touchedEmails.push(email);
  return request(app).post('/api/v1/auth/login').send({ email, password });
};
const cookieOf = (res: request.Response) => String(res.headers['set-cookie'] ?? '');
const rawCookie = (res: request.Response) => /cav_rt=([^;]*)/.exec(cookieOf(res))?.[1] ?? '';
const refreshWith = (raw: string, origin = ORIGIN) =>
  request(app).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', `cav_rt=${raw}`);

describe('POST /auth/login', () => {
  it('signs in, sets the cookie and records the login', async () => {
    const { user } = await t.addUser('manager');
    const res = await loginAs(user.email.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.role.key).toBe('manager');
    expect(res.body.data.permissions).toContain('campaigns.run');
    expect(cookieOf(res)).toMatch(
      /cav_rt=[\w-]{43}; Max-Age=2592000; Path=\/api\/v1\/auth;.*HttpOnly; SameSite=Strict/,
    );
    const fresh = await UserModel.findById(user._id).lean();
    expect(fresh?.lastLoginAt).toBeInstanceOf(Date);
    expect(await AuditLogModel.countDocuments({ action: 'auth.login', 'actor.id': user._id })).toBe(
      1,
    );
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('answers AUTH_INVALID_CREDENTIALS for a wrong password, unknown email and invited user', async () => {
    const { user } = await t.addUser('viewer');
    const invited = await t.addUser('viewer', { status: 'invited', passwordHash: null });
    for (const res of [
      await loginAs(user.email, 'wrong-password-123'),
      await loginAs('nobody-here@example.com'),
      await loginAs(invited.user.email),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(cookieOf(res)).toBe('');
    }
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.login_failed', 'actor.id': user._id }),
    ).toBe(1);
  });

  it('locks the email after 5 failures (429 + Retry-After), even for the right password', async () => {
    const { user } = await t.addUser('viewer');
    for (let i = 0; i < 5; i += 1)
      expect((await loginAs(user.email, 'wrong-password-1')).status).toBe(401);
    const locked = await loginAs(user.email);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    // window passes → can log in again, counter cleared
    await getAppRedis(getEnv().REDIS_URL, getLogger()).del(lockKey(user.email));
    expect((await loginAs(user.email)).status).toBe(200);
    expect(await getAppRedis(getEnv().REDIS_URL, getLogger()).exists(lockKey(user.email))).toBe(0);
  });

  it('reveals "disabled" only with the right password', async () => {
    const { user } = await t.addUser('viewer', { status: 'disabled' });
    expect((await loginAs(user.email, 'wrong-password-1')).body.error.code).toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
    expect((await loginAs(user.email)).body.error.code).toBe('AUTH_USER_DISABLED');
  });

  it('sends a new code to unverified users and answers AUTH_EMAIL_NOT_VERIFIED', async () => {
    const { user } = await t.addUser('owner', { emailVerifiedAt: null });
    const res = await loginAs(user.email);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
    expect(lastEmail(sent, 'auth.verify_email', user.email)).toBeDefined();
  });

  it('lets suspended accounts sign in read-only', async () => {
    const suspended = await createTestAccount({ status: 'suspended', suspendReason: 'billing' });
    const { user } = await suspended.addUser('owner');
    const res = await loginAs(user.email);
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({ status: 'suspended', suspendReason: 'billing' });
    const token = String(res.body.data.accessToken);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(200);
    const write = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${token}`);
    expect(write.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('rehashes passwords stored with old argon2 parameters', async () => {
    const weak = await hash(TEST_PASSWORD, { memoryCost: 8192, timeCost: 1, parallelism: 1 });
    const { user } = await t.addUser('viewer', { passwordHash: weak });
    expect((await loginAs(user.email)).status).toBe(200);
    const fresh = await UserModel.findById(user._id).lean();
    expect(fresh?.passwordHash).toContain('m=19456,t=2,p=1');
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the cookie and returns a working access token', async () => {
    const { user } = await t.addUser('agent');
    const first = rawCookie(await loginAs(user.email));
    const res = await refreshWith(first);
    expect(res.status).toBe(200);
    const second = rawCookie(res);
    expect(second).toMatch(/^[\w-]{43}$/);
    expect(second).not.toBe(first);
    expect(res.body.data.user.id).toBe(user._id.toString());
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.body.data.role.key).toBe('agent');
  });

  it('detects reuse of a rotated cookie and kills the whole session', async () => {
    const { user } = await t.addUser('agent');
    const first = rawCookie(await loginAs(user.email));
    const second = rawCookie(await refreshWith(first));
    const replay = await refreshWith(first);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('AUTH_SESSION_REVOKED');
    expect(cookieOf(replay)).toMatch(/cav_rt=;.*Expires=Thu, 01 Jan 1970/);
    expect((await refreshWith(second)).body.error.code).toBe('AUTH_SESSION_REVOKED');
  });

  it('rejects a missing cookie, a foreign Origin and disabled users', async () => {
    expect((await request(app).post('/api/v1/auth/refresh')).body.error.code).toBe(
      'AUTH_UNAUTHENTICATED',
    );
    const { user } = await t.addUser('agent');
    const raw = rawCookie(await loginAs(user.email));
    expect((await refreshWith(raw, 'https://evil.example')).status).toBe(403);
    await UserModel.updateOne({ _id: user._id }, { $set: { status: 'disabled' } });
    const res = await refreshWith(raw);
    expect(res.body.error.code).toBe('AUTH_USER_DISABLED');
    expect(await RefreshTokenModel.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
  });
});

describe('logout / logout-all', () => {
  it('logout is idempotent and clears the cookie', async () => {
    const { user } = await t.addUser('viewer');
    const raw = rawCookie(await loginAs(user.email));
    const out = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', `cav_rt=${raw}`);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/cav_rt=;/);
    expect(
      (await request(app).post('/api/v1/auth/logout').set('Cookie', `cav_rt=${raw}`)).status,
    ).toBe(204);
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(204);
    expect((await refreshWith(raw)).status).toBe(401);
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.logout', 'actor.id': user._id }),
    ).toBe(1);
  });

  it('logout-all invalidates every access token and session', async () => {
    const { user } = await t.addUser('viewer');
    const a = await loginAs(user.email);
    const b = await loginAs(user.email);
    const token = String(a.body.data.accessToken);
    const res = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401);
    expect((await refreshWith(rawCookie(b))).status).toBe(401);
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.logout_all', 'actor.id': user._id }),
    ).toBe(1);
  });

  it('logout-all is blocked while impersonating', async () => {
    const { user } = await t.addUser('owner');
    const imp = await tokenFor(user, { sid: 'imp_test', imp: user._id.toString() });
    const res = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${imp}`);
    expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
  });
});

describe('GET /auth/me', () => {
  it('returns the session body without a token, incl. impersonation info', async () => {
    const { user, token } = await t.addUser('admin');
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toMatchObject({
      role: { key: 'admin', name: 'Admin' },
      impersonation: null,
    });
    expect(res.body.data.accessToken).toBeUndefined();
    const imp = await tokenFor(user, { sid: 'imp_x', imp: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    const viewing = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${imp}`);
    expect(viewing.body.data.impersonation).toEqual({
      impersonatorId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      expiresAt: expect.stringMatching(/^\d{4}-/),
    });
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('sessions', () => {
  it('lists own sessions with the current flag and revokes them', async () => {
    const { user } = await t.addUser('viewer');
    const a = await loginAs(user.email);
    const b = await request(app)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'Firefox Test')
      .send({ email: user.email, password: TEST_PASSWORD });
    const token = String(a.body.data.accessToken);
    const list = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.data.find((s: { current: boolean }) => !s.current) as {
      id: string;
      userAgent: string;
    };
    expect(other.userAgent).toBe('Firefox Test');
    const del = await request(app)
      .delete(`/api/v1/auth/sessions/${other.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    expect((await refreshWith(rawCookie(b))).status).toBe(401);
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.session_revoked', 'actor.id': user._id }),
    ).toBe(1);
  });

  it("cannot revoke another user's session (404) and revoking the current one clears the cookie", async () => {
    const mine = await t.addUser('viewer');
    const theirs = await t.addUser('viewer');
    const myLogin = await loginAs(mine.user.email);
    await loginAs(theirs.user.email);
    const theirFamily =
      (await RefreshTokenModel.findOne({ userId: theirs.user._id }).lean())?.familyId ?? '';
    const token = String(myLogin.body.data.accessToken);
    expect(
      (
        await request(app)
          .delete(`/api/v1/auth/sessions/${theirFamily}`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(404);
    const current =
      (await RefreshTokenModel.findOne({ userId: mine.user._id, revokedAt: null }).lean())
        ?.familyId ?? '';
    const res = await request(app)
      .delete(`/api/v1/auth/sessions/${current}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(cookieOf(res)).toMatch(/cav_rt=;/);
  });
});

describe('PATCH /auth/me', () => {
  it('updates your own name and phone, clears the phone with null', async () => {
    const { user, token } = await t.addUser('agent');
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name', phone: '+919876543210' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ name: 'New Name', phone: '+919876543210' });
    const cleared = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: null });
    expect(cleared.body.data.user.phone).toBeNull();
    expect((await UserModel.findById(user._id).lean())?.name).toBe('New Name');
  });

  it('validates input and needs a session', async () => {
    const { token } = await t.addUser('agent');
    for (const body of [{}, { phone: '123' }, { name: '' }, { email: 'x@y.co' }]) {
      expect(
        (
          await request(app)
            .patch('/api/v1/auth/me')
            .set('Authorization', `Bearer ${token}`)
            .send(body)
        ).status,
      ).toBe(422);
    }
    expect((await request(app).patch('/api/v1/auth/me').send({ name: 'x' })).status).toBe(401);
  });
});
