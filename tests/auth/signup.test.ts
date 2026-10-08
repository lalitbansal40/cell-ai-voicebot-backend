import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { AuthCodeModel } from '../../src/db/models/auth-code.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { useTestDb } from '../helpers/db';
import { lastEmail, useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });

const PASSWORD = 'blue-tiger-river-42';
let n = 0;
const email = () => `owner${++n}-${Date.now()}@example.com`;
const signupBody = (overrides: Record<string, unknown> = {}) => ({
  businessName: 'Demo Finance',
  name: 'Asha Verma',
  email: email(),
  password: PASSWORD,
  ...overrides,
});
const codeFor = (to: string) => String(lastEmail(sent, 'auth.verify_email', to)?.vars.code);

/** Moves the user's last OTP send back in time (skips the 60 s cooldown). */
const ageLastSend = async (to: string) => {
  const user = await UserModel.findOne({ email: to });
  await AuthCodeModel.updateOne(
    { userId: user?._id },
    { $set: { lastSentAt: new Date(Date.now() - 120_000) } },
  );
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/v1/auth/signup', () => {
  it('creates account + roles + unverified owner and emails a code', async () => {
    // Asia/Kolkata: ICU lists it only as the alias Asia/Calcutta — must still pass.
    const body = signupBody({ phone: '+919876543210', timezone: 'Asia/Kolkata' });
    const res = await request(app).post('/api/v1/auth/signup').send(body);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      data: { message: 'Check your email for a verification code.' },
    });

    const user = await UserModel.findOne({ email: body.email }).lean();
    expect(user).toMatchObject({ status: 'active', emailVerifiedAt: null, phone: '+919876543210' });
    const account = await AccountModel.findById(user?.accountId).lean();
    expect(account).toMatchObject({
      name: 'Demo Finance',
      timezone: 'Asia/Kolkata',
      status: 'active',
    });
    expect(account?.ownerId?.toString()).toBe(user?._id.toString());
    expect(account?.slug).toMatch(/^demo-finance/);
    expect(await RoleModel.countDocuments({ accountId: account?._id })).toBe(5);
    const ownerRole = await RoleModel.findById(user?.roleId).lean();
    expect(ownerRole?.key).toBe('owner');
    expect(codeFor(body.email)).toMatch(/^\d{6}$/);
    expect(lastEmail(sent, 'auth.verify_email', body.email)?.vars).toMatchObject({
      name: 'Asha Verma',
      minutes: 10,
    });
    expect(
      await AuditLogModel.countDocuments({ accountId: account?._id, action: 'account.created' }),
    ).toBe(1);
  });

  it('gives a second account with the same name a different slug', async () => {
    const a = signupBody({ businessName: 'Same Name Loans' });
    const b = signupBody({ businessName: 'Same Name Loans' });
    await request(app).post('/api/v1/auth/signup').send(a);
    await request(app).post('/api/v1/auth/signup').send(b);
    const [ua, ub] = await Promise.all([
      UserModel.findOne({ email: a.email }),
      UserModel.findOne({ email: b.email }),
    ]);
    const [aa, ab] = await Promise.all([
      AccountModel.findById(ua?.accountId),
      AccountModel.findById(ub?.accountId),
    ]);
    expect(aa?.slug).toBe('same-name-loans');
    expect(ab?.slug).toMatch(/^same-name-loans-[a-f0-9]{4}$/);
  });

  it('answers 202 for an existing (verified) email and sends "account exists" instead', async () => {
    const body = signupBody();
    await request(app).post('/api/v1/auth/signup').send(body);
    await UserModel.updateOne({ email: body.email }, { $set: { emailVerifiedAt: new Date() } });
    const accounts = await AccountModel.countDocuments();
    const started = Date.now();
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ ...body, businessName: 'Another Co' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(res.status).toBe(202);
    expect(await AccountModel.countDocuments()).toBe(accounts);
    const mail = lastEmail(sent, 'auth.account_exists', body.email);
    expect(mail?.vars).toMatchObject({
      loginUrl: 'http://localhost:3100/login',
      resetUrl: 'http://localhost:3100/forgot-password',
    });
  });

  it('re-sends a code when an unverified owner signs up again (after the cooldown)', async () => {
    const body = signupBody();
    await request(app).post('/api/v1/auth/signup').send(body);
    const first = codeFor(body.email);
    const count = sent.filter((m) => m.to === body.email).length;
    await request(app).post('/api/v1/auth/signup').send(body); // within cooldown → silently nothing
    expect(sent.filter((m) => m.to === body.email)).toHaveLength(count);
    await ageLastSend(body.email);
    await request(app).post('/api/v1/auth/signup').send(body);
    expect(sent.filter((m) => m.to === body.email)).toHaveLength(count + 1);
    expect(
      await AccountModel.countDocuments({ name: body.businessName, ownerId: { $exists: true } }),
    ).toBeGreaterThan(0);
    expect(codeFor(body.email)).toMatch(/^\d{6}$/);
    expect(first).toMatch(/^\d{6}$/);
  });

  it.each([
    ['weak password', { password: 'short' }, 'body.password'],
    ['common password', { password: '1234567890' }, 'body.password'],
    [
      'password with the email',
      { email: 'ashaverma@example.com', password: 'ashaverma-secret-1' },
      'body.password',
    ],
    ['bad email', { email: 'not-an-email' }, 'body.email'],
    ['bad phone', { phone: '12345' }, 'body.phone'],
    ['bad timezone', { timezone: 'Mars/Olympus' }, 'body.timezone'],
    ['short business name', { businessName: 'A' }, 'body.businessName'],
  ])('rejects %s with 422', async (_name, overrides, path) => {
    const res = await request(app).post('/api/v1/auth/signup').send(signupBody(overrides));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('rejects unknown fields (strict body)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send(signupBody({ accountId: 'x' }));
    expect(res.status).toBe(422);
  });

  it('rolls back the account and roles when creating the owner fails', async () => {
    const body = signupBody({ businessName: 'Rollback Test Ltd' });
    vi.spyOn(UserModel, 'create').mockRejectedValueOnce(new Error('simulated failure'));
    const res = await request(app).post('/api/v1/auth/signup').send(body);
    expect(res.status).toBe(500);
    expect(await AccountModel.countDocuments({ name: 'Rollback Test Ltd' })).toBe(0);
    expect(await UserModel.countDocuments({ email: body.email })).toBe(0);
  });
});

describe('POST /api/v1/auth/verify-email', () => {
  const signupAndCode = async () => {
    const body = signupBody();
    await request(app).post('/api/v1/auth/signup').send(body);
    return { body, code: codeFor(body.email) };
  };

  it('verifies, signs in and sets the refresh cookie', async () => {
    const { body, code } = await signupAndCode();
    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: body.email, code });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(data.expiresIn).toBeGreaterThan(800);
    expect(data.user).toMatchObject({ email: body.email, status: 'active', platformRole: null });
    expect(data.user.emailVerifiedAt).toBeTruthy();
    expect(data.role).toEqual({ key: 'owner', name: 'Owner' });
    expect(data.permissions).toContain('team.invite');
    expect(data.permissions).not.toContain('platform.impersonate');
    expect(data.impersonation).toBeNull();
    expect(data.account).toMatchObject({
      name: 'Demo Finance',
      status: 'active',
      isPlatform: false,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenVersion|argon2/);

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^cav_rt=[\w-]{43};/);
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toMatch(/Max-Age=2592000/);

    const me = await UserModel.findOne({ email: body.email }).lean();
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.email_verified', 'actor.id': me?._id }),
    ).toBe(1);
  });

  it('rejects a code used twice and an already verified user', async () => {
    const { body, code } = await signupAndCode();
    await request(app).post('/api/v1/auth/verify-email').send({ email: body.email, code });
    const again = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: body.email, code });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('locks the code after 5 wrong tries', async () => {
    const { body, code } = await signupAndCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ email: body.email, code: wrong });
      expect(res.body.error.code).toBe('AUTH_CODE_INVALID');
    }
    const fifth = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: body.email, code: wrong });
    expect(fifth.status).toBe(429);
    expect(fifth.headers['retry-after']).toBeDefined();
    const right = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: body.email, code });
    expect(right.status).toBe(429);
  });

  it('rejects an expired code', async () => {
    const { body, code } = await signupAndCode();
    const user = await UserModel.findOne({ email: body.email });
    await AuthCodeModel.updateOne(
      { userId: user?._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: body.email, code });
    expect(res.body.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('answers AUTH_CODE_INVALID for unknown emails and malformed codes', async () => {
    const unknown = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: 'nobody@example.com', code: '123456' });
    expect(unknown.body.error.code).toBe('AUTH_CODE_INVALID');
    const malformed = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: 'nobody@example.com', code: '12ab' });
    expect(malformed.status).toBe(422);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v1/auth/verify-email/resend', () => {
  it('always answers 202 and respects the cooldown', async () => {
    const body = signupBody();
    await request(app).post('/api/v1/auth/signup').send(body);
    const count = () =>
      sent.filter((m) => m.to === body.email && m.template === 'auth.verify_email').length;
    const before = count();
    const early = await request(app)
      .post('/api/v1/auth/verify-email/resend')
      .send({ email: body.email });
    expect(early.status).toBe(202);
    expect(count()).toBe(before);
    await ageLastSend(body.email);
    await request(app).post('/api/v1/auth/verify-email/resend').send({ email: body.email });
    expect(count()).toBe(before + 1);
    const unknown = await request(app)
      .post('/api/v1/auth/verify-email/resend')
      .send({ email: 'ghost@example.com' });
    expect(unknown.status).toBe(202);
    expect(sent.some((m) => m.to === 'ghost@example.com')).toBe(false);
  });
});

describe('auth rate limit', () => {
  it('limits public auth routes per IP and route', async () => {
    const limited = buildTestApp({}, { authRateLimit: { limit: 2 } });
    const hit = () =>
      request(limited).post('/api/v1/auth/verify-email/resend').send({ email: 'x@example.com' });
    expect((await hit()).status).toBe(202);
    expect((await hit()).status).toBe(202);
    const third = await hit();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    // a different route has its own counter
    expect((await request(limited).post('/api/v1/auth/signup').send(signupBody())).status).toBe(
      202,
    );
  });
});
