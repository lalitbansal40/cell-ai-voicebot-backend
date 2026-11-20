import type { Request } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { startLoginAs } from '../../src/modules/auth/login-as';
import { hasStepUp } from '../../src/modules/auth/login-as-session';
import { base32Decode, hotp, stepOf } from '../../src/modules/auth/totp';
import { createTestAccount, TEST_PASSWORD, tokenFor, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

/** SAC-T1: superadmin "Full access" login-as — start, /auth/me, extend, step-up, ring me too. */
useTestDb();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });

let superadmin: TestUser;
let owner: TestUser;
let customerId: string;
const HOUR = 3_600_000;
const nowSec = () => Math.floor(Date.now() / 1000);
/** Session ids unique per run (Redis outlives the test database). */
const sidOf = (name: string) => `imp_${name}_${Date.now().toString(36)}`;

const fullToken = (opts: { startedAgoMs?: number; ttl?: string; sid?: string } = {}) =>
  tokenFor(owner.user, {
    sid: opts.sid ?? `imp_${Math.random().toString(36).slice(2)}`,
    imp: superadmin.user._id.toString(),
    imm: 'full',
    imk: 'superadmin',
    ims: nowSec() - Math.floor((opts.startedAgoMs ?? 0) / 1000),
    ttl: opts.ttl ?? '4h',
  });

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await requireRedis();
  const customer = await createTestAccount();
  owner = await customer.addUser('owner');
  customerId = customer.account._id.toString();
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

describe('full access: start (SAC-T1)', () => {
  it('a superadmin enters an account with full access for 4 hours, audited twice', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/accounts/${customerId}/impersonate`)
      .set(as(superadmin.token))
      .send({ mode: 'full' });
    expect(res.status).toBe(200);
    const imp = res.body.data.impersonation;
    expect(imp).toMatchObject({ mode: 'full', kind: 'superadmin', ringMeToo: false });
    expect(Date.parse(imp.maxUntil) - Date.parse(imp.startedAt)).toBe(12 * HOUR);
    expect(res.body.data.expiresIn).toBeGreaterThan(4 * 3600 - 60);
    expect(res.body.data.expiresIn).toBeLessThanOrEqual(4 * 3600);
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_as_full_started' })).toBe(2);
    const me = await request(app).get('/api/v1/auth/me').set(as(res.body.data.accessToken));
    expect(me.body.data.impersonation).toMatchObject({
      mode: 'full',
      startedAt: imp.startedAt,
      maxUntil: imp.maxUntil,
      ringMeToo: false,
    });
  });

  it('a reseller can never use full access', async () => {
    const req = {
      auth: {
        kind: 'user',
        accountId: superadmin.user.accountId.toString(),
        userId: superadmin.user._id.toString(),
        permissions: new Set(),
      },
      ip: '127.0.0.1',
    } as unknown as Request;
    const customer = await createTestAccount();
    await customer.addUser('owner');
    await expect(
      startLoginAs(req, customer.account, {
        mode: 'full',
        kind: 'reseller',
        action: 'reseller.login_as_started',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it('view and act keep 30 minutes and have no full facts', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/accounts/${customerId}/impersonate`)
      .set(as(superadmin.token))
      .send({ mode: 'act' });
    expect(res.body.data.expiresIn).toBeLessThanOrEqual(30 * 60);
    expect(res.body.data.impersonation.startedAt).toBeUndefined();
  });
});

describe('full access: extend (SAC-T1)', () => {
  it('gives 4 more hours from now', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login-as/extend')
      .set(as(await fullToken({ startedAgoMs: HOUR, ttl: '1h' })));
    expect(res.status).toBe(200);
    expect(res.body.data.expiresIn).toBeGreaterThan(4 * 3600 - 60);
    expect(res.body.data.impersonation.mode).toBe('full');
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_as_full_extended' })).toBe(2);
  });

  it('never past 12 hours from the start; nothing left → 409', async () => {
    const near = await request(app)
      .post('/api/v1/auth/login-as/extend')
      .set(as(await fullToken({ startedAgoMs: 11 * HOUR, ttl: '5m' })));
    expect(near.status).toBe(200);
    expect(near.body.data.expiresIn).toBeLessThanOrEqual(3600);
    expect(near.body.data.expiresIn).toBeGreaterThan(3600 - 60);
    const done = await request(app)
      .post('/api/v1/auth/login-as/extend')
      .set(as(await fullToken({ startedAgoMs: 12 * HOUR - 30_000, ttl: '25s' })));
    expect(done.status).toBe(409);
  });

  it('only a full session may extend', async () => {
    const act = await tokenFor(owner.user, {
      sid: 'imp_act',
      imp: superadmin.user._id.toString(),
      imm: 'act',
      imk: 'superadmin',
    });
    expect((await request(app).post('/api/v1/auth/login-as/extend').set(as(act))).status).toBe(403);
    expect(
      (await request(app).post('/api/v1/auth/login-as/extend').set(as(owner.token))).status,
    ).toBe(403);
  });
});

describe('full access: step-up and ring me too (SAC-T1)', () => {
  it("the superadmin's own password grants 5 minutes; a wrong one is refused and counted", async () => {
    const sid = sidOf('stepup_pw');
    const t = await fullToken({ sid });
    const wrong = await request(app)
      .post('/api/v1/auth/login-as/step-up')
      .set(as(t))
      .send({ password: 'not-the-password' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('REAUTH_FAILED');
    expect(await hasStepUp(sid)).toBe(false);
    const right = await request(app)
      .post('/api/v1/auth/login-as/step-up')
      .set(as(t))
      .send({ password: TEST_PASSWORD });
    expect(right.status).toBe(200);
    expect(Date.parse(right.body.data.stepUpUntil) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(await hasStepUp(sid)).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_as_step_up' })).toBe(2);
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_as_step_up_failed' })).toBe(2);
  });

  it('with two-step sign-in on, a code is needed too', async () => {
    const platform = await createTestAccount({ isPlatform: true });
    const sa = await platform.addUser('owner', { platformRole: 'superadmin' });
    const setup = await request(app).post('/api/v1/auth/mfa/setup').set(as(sa.token));
    const secret: string = setup.body.data.secret;
    const now = new Date();
    await request(app)
      .post('/api/v1/auth/mfa/confirm')
      .set(as(sa.token))
      .send({ code: hotp(base32Decode(secret), stepOf(now)) });
    const t = await tokenFor(owner.user, {
      sid: sidOf('stepup_mfa'),
      imp: sa.user._id.toString(),
      imm: 'full',
      imk: 'superadmin',
      ims: nowSec(),
    });
    const noCode = await request(app)
      .post('/api/v1/auth/login-as/step-up')
      .set(as(t))
      .send({ password: TEST_PASSWORD });
    expect(noCode.body.error.code).toBe('MFA_REQUIRED');
    const ok = await request(app)
      .post('/api/v1/auth/login-as/step-up')
      .set(as(t))
      .send({
        password: TEST_PASSWORD,
        code: hotp(base32Decode(secret), stepOf(new Date(now.getTime() + 30_000))),
      });
    expect(ok.status).toBe(200);
  });

  it('5 failures in 15 minutes lock the step-up (429)', async () => {
    const platform = await createTestAccount({ isPlatform: true });
    const sa = await platform.addUser('owner', { platformRole: 'superadmin' });
    const t = await tokenFor(owner.user, {
      sid: sidOf('stepup_lock'),
      imp: sa.user._id.toString(),
      imm: 'full',
      imk: 'superadmin',
      ims: nowSec(),
    });
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/v1/auth/login-as/step-up').set(as(t)).send({ password: 'x' });
    }
    const locked = await request(app)
      .post('/api/v1/auth/login-as/step-up')
      .set(as(t))
      .send({ password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
  });

  it('ring me too is on for the session until switched off, and /auth/me shows it', async () => {
    const t = await fullToken({ sid: sidOf('ring') });
    const on = await request(app)
      .put('/api/v1/auth/login-as/ring-me-too')
      .set(as(t))
      .send({ on: true });
    expect(on.body.data).toEqual({ ringMeToo: true });
    const me = await request(app).get('/api/v1/auth/me').set(as(t));
    expect(me.body.data.impersonation.ringMeToo).toBe(true);
    await request(app).put('/api/v1/auth/login-as/ring-me-too').set(as(t)).send({ on: false });
    const after = await request(app).get('/api/v1/auth/me').set(as(t));
    expect(after.body.data.impersonation.ringMeToo).toBe(false);
  });
});
