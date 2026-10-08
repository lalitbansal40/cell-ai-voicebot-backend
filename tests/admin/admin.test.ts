import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let platform: TestAccount;
let superadmin: TestUser;
let customer: TestAccount;
let owner: TestUser;

beforeAll(async () => {
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-${Date.now()}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  customer = await createTestAccount({ name: 'Acme Loans' });
  owner = await customer.addUser('owner');
  await customer.addUser('manager');
  await customer.addUser('viewer', { status: 'disabled' });
});

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set(auth(token)),
  post: (url: string, body: object = {}) => request(app).post(url).set(auth(token)).send(body),
});

describe('superadmin guard', () => {
  it('rejects every admin route for account users (even owners) and anonymous calls', async () => {
    const id = customer.account._id.toString();
    for (const [method, url] of [
      ['get', '/api/v1/admin/accounts'],
      ['get', `/api/v1/admin/accounts/${id}`],
      ['post', `/api/v1/admin/accounts/${id}/suspend`],
      ['post', `/api/v1/admin/accounts/${id}/enable`],
      ['post', `/api/v1/admin/accounts/${id}/impersonate`],
    ] as const) {
      const res =
        method === 'get'
          ? await as(owner.token).get(url)
          : await as(owner.token).post(url, { reason: 'x x x' });
      expect(res.status).toBe(403);
      expect((await request(app)[method](url)).status).toBe(401);
    }
  });
});

describe('accounts', () => {
  it('lists customer accounts (not the platform) with owner email and user counts', async () => {
    const res = await as(superadmin.token).get('/api/v1/admin/accounts').query({ search: 'acme' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        name: 'Acme Loans',
        status: 'active',
        ownerEmail: owner.user.email,
        usersCount: 3,
      }),
    ]);
    const all = await as(superadmin.token).get('/api/v1/admin/accounts').query({ limit: 100 });
    expect(all.body.data.some((a: { name: string }) => a.name === 'Platform')).toBe(false);
    const byOwner = await as(superadmin.token)
      .get('/api/v1/admin/accounts')
      .query({ search: owner.user.email });
    expect(byOwner.body.data.map((a: { id: string }) => a.id)).toEqual([
      customer.account._id.toString(),
    ]);
  });

  it('shows the account detail', async () => {
    const res = await as(superadmin.token).get(
      `/api/v1/admin/accounts/${customer.account._id.toString()}`,
    );
    expect(res.body.data).toMatchObject({
      account: { name: 'Acme Loans' },
      owner: { email: owner.user.email },
      usersCount: 3,
      usersByStatus: { invited: 0, active: 2, disabled: 1 },
    });
    expect(Array.isArray(res.body.data.recentAudit)).toBe(true);
    expect(
      (await as(superadmin.token).get(`/api/v1/admin/accounts/${platform.account._id.toString()}`))
        .status,
    ).toBe(409);
    expect(
      (await as(superadmin.token).get('/api/v1/admin/accounts/aaaaaaaaaaaaaaaaaaaaaaaa')).status,
    ).toBe(404);
  });

  it('suspends (writes blocked, reads ok) and enables, audited on both sides', async () => {
    const id = customer.account._id.toString();
    const res = await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/suspend`, {
      reason: 'Unpaid invoice',
    });
    expect(res.body.data).toMatchObject({ status: 'suspended', suspendReason: 'Unpaid invoice' });
    expect(
      (await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/suspend`, { reason: 'again' }))
        .status,
    ).toBe(409);
    expect((await as(owner.token).get('/api/v1/account')).status).toBe(200);
    expect(
      (await request(app).patch('/api/v1/account').set(auth(owner.token)).send({ name: 'Nope Co' }))
        .body.error.code,
    ).toBe('AUTH_ACCOUNT_SUSPENDED');
    expect(
      await AuditLogModel.countDocuments({
        accountId: customer.account._id,
        action: 'account.suspended',
        'actor.platform': true,
      }),
    ).toBe(1);
    expect(
      await AuditLogModel.countDocuments({
        accountId: platform.account._id,
        action: 'account.suspended',
      }),
    ).toBe(1);

    const enabled = await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/enable`);
    expect(enabled.body.data).toMatchObject({ status: 'active', suspendReason: null });
    expect(
      (
        await request(app)
          .patch('/api/v1/account')
          .set(auth(owner.token))
          .send({ name: 'Acme Loans' })
      ).status,
    ).toBe(200);
    expect((await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/enable`)).status).toBe(
      409,
    );
    expect(
      (await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/suspend`, { reason: 'x' }))
        .status,
    ).toBe(422);
  });

  it('protects the platform account', async () => {
    const id = platform.account._id.toString();
    expect(
      (
        await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/suspend`, {
          reason: 'test test',
        })
      ).status,
    ).toBe(409);
    expect(
      (await as(superadmin.token).post(`/api/v1/admin/accounts/${id}/impersonate`)).status,
    ).toBe(409);
    expect((await AccountModel.findById(id).lean())?.status).toBe('active');
  });
});

describe('impersonation', () => {
  it('gives a 30-minute owner token with the imp claim and no cookie', async () => {
    const res = await as(superadmin.token).post(
      `/api/v1/admin/accounts/${customer.account._id.toString()}/impersonate`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.body.data as {
      accessToken: string;
      expiresIn: number;
      user: { id: string };
      impersonation: { impersonatorId: string };
    };
    expect(data.user.id).toBe(owner.user._id.toString());
    expect(data.expiresIn).toBeGreaterThan(29 * 60);
    expect(data.expiresIn).toBeLessThanOrEqual(30 * 60);
    expect(data.impersonation.impersonatorId).toBe(superadmin.user._id.toString());

    const me = await as(data.accessToken).get('/api/v1/auth/me');
    expect(me.body.data.impersonation.impersonatorId).toBe(superadmin.user._id.toString());
    expect(me.body.data.permissions).not.toContain('platform.impersonate');
    // works as the owner …
    expect((await as(data.accessToken).get('/api/v1/team/users')).status).toBe(200);
    // … but sensitive actions are blocked, and admin routes are not reachable
    expect(
      (
        await as(data.accessToken).post('/api/v1/auth/change-password', {
          currentPassword: 'x',
          newPassword: 'y',
        })
      ).body.error.code,
    ).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect(
      (
        await as(data.accessToken).post('/api/v1/team/transfer-ownership', {
          userId: owner.user._id.toString(),
          password: 'x',
        })
      ).body.error.code,
    ).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect(
      (await as(data.accessToken).post('/api/v1/api-keys', { name: 'x', scopes: ['calls:read'] }))
        .body.error.code,
    ).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await as(data.accessToken).post('/api/v1/auth/logout-all')).body.error.code).toBe(
      'AUTH_IMPERSONATION_BLOCKED',
    );
    expect((await as(data.accessToken).get('/api/v1/admin/accounts')).status).toBe(403);
    // refresh never issues impersonation tokens (no cookie exists)
    expect((await request(app).post('/api/v1/auth/refresh')).status).toBe(401);

    expect((await as(data.accessToken).post('/api/v1/admin/impersonation/stop')).status).toBe(204);
    expect(
      await AuditLogModel.countDocuments({
        action: 'admin.impersonation_started',
        accountId: customer.account._id,
      }),
    ).toBe(1);
    expect(
      await AuditLogModel.countDocuments({
        action: 'admin.impersonation_started',
        accountId: platform.account._id,
      }),
    ).toBe(1);
    expect(
      await AuditLogModel.countDocuments({
        action: 'admin.impersonation_stopped',
        accountId: customer.account._id,
      }),
    ).toBe(1);
    expect(
      await AuditLogModel.countDocuments({
        action: 'admin.impersonation_stopped',
        accountId: platform.account._id,
      }),
    ).toBe(1);
  });

  it('expires after 30 minutes and stop needs an impersonation token', async () => {
    const expired = await tokenFor(owner.user, {
      sid: 'imp_old',
      imp: superadmin.user._id.toString(),
      ttl: '-1m',
    });
    expect((await as(expired).get('/api/v1/auth/me')).body.error.code).toBe('AUTH_TOKEN_EXPIRED');
    expect((await as(owner.token).post('/api/v1/admin/impersonation/stop')).status).toBe(409);
  });

  it('refuses accounts without an active owner', async () => {
    const orphan = await createTestAccount({ name: 'Orphan Co' });
    await orphan.addUser('owner', { status: 'disabled' });
    expect(
      (
        await as(superadmin.token).post(
          `/api/v1/admin/accounts/${orphan.account._id.toString()}/impersonate`,
        )
      ).status,
    ).toBe(409);
  });
});
