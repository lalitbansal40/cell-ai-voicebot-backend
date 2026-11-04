import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });

const PASSWORD = 'blue-tiger-river-42';
let n = 0;
const email = () => `owner${String(++n)}-${String(Date.now())}@example.com`;
const body = (overrides: Record<string, unknown> = {}) => ({
  accountType: 'business',
  businessName: 'Demo Finance',
  name: 'Asha Verma',
  email: email(),
  password: PASSWORD,
  acceptTerms: true,
  ...overrides,
});
const signup = (b: Record<string, unknown>, a = app) =>
  request(a).post('/api/v1/auth/signup').send(b);
const setSignup = (value: Record<string, unknown>) =>
  PlatformSettingsModel.updateOne({ key: 'signup' }, { $set: { value } }, { upsert: true });

beforeAll(async () => {
  await requireRedis();
});

describe('POST /auth/signup — no e-mail (Phase 19)', () => {
  it('a business signs up and is logged in at once: account, roles, wallet, verified owner', async () => {
    const b = body({ phone: '+919876543210', timezone: 'Asia/Kolkata' });
    const res = await signup(b);
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.account).toMatchObject({ kind: 'business', parentAccountId: null });
    expect(res.headers['set-cookie']?.[0]).toMatch(/^cav_rt=/);
    const user = await UserModel.findOne({ email: b.email }).lean();
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    const accountId = user?.accountId;
    expect(await RoleModel.countDocuments({ accountId })).toBe(5);
    expect(await WalletModel.countDocuments({ accountId })).toBe(1);
    expect(
      await AuditLogModel.findOne({ action: 'account.signed_up', accountId }).lean(),
    ).toMatchObject({ meta: { kind: 'business' } });
    expect(sent.length).toBe(0);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${String(res.body.data.accessToken)}`);
    expect(me.status).toBe(200);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: b.email, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('a reseller signs up active; superadmins get a bell', async () => {
    const platform = await createTestAccount({ isPlatform: true });
    await platform.addUser('owner', { platformRole: 'superadmin' });
    const res = await signup(body({ accountType: 'reseller', businessName: 'Agency One' }));
    expect(res.status).toBe(201);
    expect(res.body.data.account).toMatchObject({
      kind: 'reseller',
      reseller: { status: 'active', customersCanTopUp: false },
    });
    expect(
      await NotificationModel.countDocuments({ type: 'account.reseller_signed_up' }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('reseller signup on approval → pending; closed → SIGNUP_CLOSED; platform closed → 403', async () => {
    await setSignup({ open: true, resellerSignup: 'approval' });
    const pending = await signup(body({ accountType: 'reseller' }));
    expect(pending.body.data.account.reseller.status).toBe('pending_approval');
    await setSignup({ open: true, resellerSignup: 'closed' });
    const closed = await signup(body({ accountType: 'reseller' }));
    expect(closed.status).toBe(403);
    expect(closed.body.error).toMatchObject({
      code: 'SIGNUP_CLOSED',
      details: [{ path: 'accountType' }],
    });
    expect((await signup(body())).status).toBe(201);
    await setSignup({ open: false, resellerSignup: 'open' });
    const off = await signup(body());
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('SIGNUP_CLOSED');
    const options = await request(app).get('/api/v1/auth/signup-options');
    expect(options.body.data).toEqual({ open: false, resellerSignup: 'open' });
    await setSignup({ open: true, resellerSignup: 'open' });
  });

  it('a taken e-mail answers AUTH_EMAIL_TAKEN and creates nothing', async () => {
    const b = body();
    expect((await signup(b)).status).toBe(201);
    const before = await AccountModel.countDocuments();
    const again = await signup({ ...b, businessName: 'Other' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AUTH_EMAIL_TAKEN');
    expect(await AccountModel.countDocuments()).toBe(before);
  });

  it('refuses the honeypot, a weak password, a missing terms tick and an unknown type', async () => {
    const before = await AccountModel.countDocuments();
    expect((await signup(body({ website: 'http://spam.example' }))).status).toBe(422);
    expect((await signup(body({ password: 'password' }))).status).toBe(422);
    expect((await signup(body({ acceptTerms: false }))).status).toBe(422);
    expect((await signup(body({ accountType: 'admin' }))).status).toBe(422);
    expect(await AccountModel.countDocuments()).toBe(before);
  });

  it('5 signups an hour per IP (signup-ip limiter)', async () => {
    const limited = buildTestApp();
    for (let i = 0; i < 5; i += 1) expect((await signup(body(), limited)).status).toBe(201);
    const sixth = await signup(body(), limited);
    expect(sixth.status).toBe(429);
  });

  it('the old e-mail code routes answer 410 AUTH_ROUTE_GONE', async () => {
    for (const path of ['/api/v1/auth/verify-email', '/api/v1/auth/verify-email/resend']) {
      const res = await request(app).post(path).send({ email: 'a@example.com', code: '123456' });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('AUTH_ROUTE_GONE');
    }
  });
});
