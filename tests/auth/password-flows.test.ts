import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeAllRedis } from '../../src/core/queues/redis';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { AuthCodeModel } from '../../src/db/models/auth-code.model';
import { UserModel } from '../../src/db/models/user.model';
import { verifyPassword } from '../../src/modules/auth/password';
import { createTestAccount, TEST_PASSWORD, tokenFor, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { lastEmail, useCapturedEmail } from '../helpers/email';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });
const NEW_PASSWORD = 'green-falcon-lake-77';
let t: TestAccount;

beforeAll(async () => {
  await requireRedis();
  t = await createTestAccount();
});
afterAll(async () => {
  await closeAllRedis();
});

const login = (email: string, password = TEST_PASSWORD) =>
  request(app).post('/api/v1/auth/login').send({ email, password });
const tokenFromEmail = (to: string) => {
  const url = String(lastEmail(sent, 'auth.reset_password', to)?.vars.resetUrl);
  return new URL(url).searchParams.get('token') ?? '';
};
const forgot = (email: string) => request(app).post('/api/v1/auth/forgot-password').send({ email });

describe('forgot + reset password', () => {
  it('emails a reset link only to active verified users, always 202', async () => {
    const active = await t.addUser('viewer');
    const unverified = await t.addUser('viewer', { emailVerifiedAt: null });
    const invited = await t.addUser('viewer', { status: 'invited', passwordHash: null });
    for (const email of [
      active.user.email,
      unverified.user.email,
      invited.user.email,
      'ghost@example.com',
    ]) {
      const res = await forgot(email);
      expect(res.status).toBe(202);
      expect(res.body.data.message).toBe(
        'If an account exists for this email, we sent a reset link.',
      );
    }
    const mail = lastEmail(sent, 'auth.reset_password', active.user.email);
    expect(mail?.vars.resetUrl).toMatch(
      /^http:\/\/localhost:3100\/reset-password\?token=[\w-]{43}$/,
    );
    expect(mail?.vars.minutes).toBe(30);
    for (const other of [unverified.user.email, invited.user.email, 'ghost@example.com']) {
      expect(lastEmail(sent, 'auth.reset_password', other)).toBeUndefined();
    }
    expect(
      await AuditLogModel.countDocuments({
        action: 'auth.password_reset_requested',
        'actor.id': active.user._id,
      }),
    ).toBe(1);
  });

  it('resets the password, ends every session and is single use', async () => {
    const { user } = await t.addUser('manager');
    const session = await login(user.email);
    const oldToken = String(session.body.data.accessToken);
    await forgot(user.email);
    const token = tokenFromEmail(user.email);

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toContain('sign in again');

    const fresh = await UserModel.findById(user._id).lean();
    expect((await verifyPassword(fresh?.passwordHash ?? '', NEW_PASSWORD)).ok).toBe(true);
    expect(fresh?.tokenVersion).toBe(user.tokenVersion + 1);
    expect(fresh?.passwordChangedAt).toBeInstanceOf(Date);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${oldToken}`)).status,
    ).toBe(401);
    const cookie = /cav_rt=([^;]*)/.exec(String(session.headers['set-cookie']))?.[1] ?? '';
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', `cav_rt=${cookie}`)).status,
    ).toBe(401);
    expect(lastEmail(sent, 'auth.password_changed', user.email)).toBeDefined();
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.password_reset', 'actor.id': user._id }),
    ).toBe(1);

    const again = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'purple-otter-hill-31' });
    expect(again.body.error.code).toBe('AUTH_CODE_INVALID');
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('does not burn the link when the new password is weak', async () => {
    const { user } = await t.addUser('viewer');
    await forgot(user.email);
    const token = tokenFromEmail(user.email);
    const weak = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: '1234567890' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.details[0]).toMatchObject({ path: 'body.password' });
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token, password: NEW_PASSWORD })
      ).status,
    ).toBe(200);
  });

  it('rejects expired, unknown and malformed tokens, and disabled users', async () => {
    const { user } = await t.addUser('viewer');
    await forgot(user.email);
    const token = tokenFromEmail(user.email);
    await AuthCodeModel.updateOne(
      { userId: user._id, purpose: 'reset_password' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token, password: NEW_PASSWORD })
      ).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token: 'x'.repeat(43), password: NEW_PASSWORD })
      ).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token: 'short', password: NEW_PASSWORD })
      ).status,
    ).toBe(422);

    const disabled = await t.addUser('viewer');
    await forgot(disabled.user.email);
    const dToken = tokenFromEmail(disabled.user.email);
    await UserModel.updateOne({ _id: disabled.user._id }, { $set: { status: 'disabled' } });
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token: dToken, password: NEW_PASSWORD })
      ).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password, keeps this session, ends the others', async () => {
    const { user } = await t.addUser('admin');
    const here = await login(user.email);
    const there = await login(user.email);
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${here.body.data.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    const newToken = String(res.body.data.accessToken);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${newToken}`)).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${here.body.data.accessToken}`)
      ).status,
    ).toBe(401);
    const hereCookie = /cav_rt=([^;]*)/.exec(String(here.headers['set-cookie']))?.[1] ?? '';
    const thereCookie = /cav_rt=([^;]*)/.exec(String(there.headers['set-cookie']))?.[1] ?? '';
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', `cav_rt=${hereCookie}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', `cav_rt=${thereCookie}`))
        .status,
    ).toBe(401);
    expect(lastEmail(sent, 'auth.password_changed', user.email)).toBeDefined();
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.password_changed', 'actor.id': user._id }),
    ).toBe(1);
  });

  it('rejects a wrong current password, the same password and weak ones', async () => {
    const { token } = await t.addUser('viewer');
    const call = (body: object) =>
      request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    expect(
      (await call({ currentPassword: 'wrong-password-1', newPassword: NEW_PASSWORD })).body.error
        .code,
    ).toBe('AUTH_INVALID_CREDENTIALS');
    const same = await call({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(same.body.error.details[0]).toMatchObject({ path: 'body.newPassword' });
    const weak = await call({ currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(422);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/change-password')
          .send({ currentPassword: 'a', newPassword: 'b' })
      ).status,
    ).toBe(401);
  });

  it('is blocked while impersonating', async () => {
    const { user } = await t.addUser('owner');
    const imp = await tokenFor(user, { sid: 'imp_z', imp: user._id.toString() });
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${imp}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
  });
});
