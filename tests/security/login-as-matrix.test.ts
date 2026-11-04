import type { Request } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { loginAsCustomer } from '../../src/modules/resellers/resellers.service';
import { createTestAccount, tokenFor, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });

let customer: TestAccount;
let ownerId: string;
let token: (mode: 'view' | 'act', kind?: 'superadmin' | 'reseller') => Promise<string>;

beforeAll(async () => {
  await requireRedis();
  customer = await createTestAccount();
  const owner = await customer.addUser('owner');
  ownerId = owner.user._id.toString();
  const platform = await createTestAccount({ isPlatform: true });
  const admin = await platform.addUser('owner', { platformRole: 'superadmin' });
  token = (mode, kind = 'superadmin') =>
    tokenFor(owner.user, {
      sid: 'imp_test',
      imp: admin.user._id.toString(),
      imm: mode,
      imk: kind,
    });
});

const call = (method: 'post' | 'patch' | 'put' | 'delete', path: string, t: string) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${t}`).send({});

/** Sensitive in every login-as session (both modes). */
const SENSITIVE: ['post' | 'patch' | 'put' | 'delete', string][] = [
  ['post', '/auth/change-password'],
  ['post', '/auth/logout-all'],
  ['delete', '/auth/sessions/fam1'],
  ['post', '/auth/mfa/setup'],
  ['post', '/api-keys'],
  ['post', '/wallet/topups'],
  ['patch', '/wallet/settings'],
  ['put', '/billing/profile'],
  ['post', '/team/transfer-ownership'],
  ['post', '/account/export'],
  ['post', '/webhook-endpoints'],
];

describe('login as: view / act (T19.3)', () => {
  it.each(SENSITIVE)('%s %s is refused in view and act', async (method, path) => {
    for (const mode of ['view', 'act'] as const) {
      const res = await call(method, path, await token(mode));
      expect(res.status, `${mode} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    }
  });

  it('ordinary changes: refused in view, allowed in act', async () => {
    const view = await call('post', '/team/invites', await token('view'));
    expect(view.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const act = await request(app)
      .post('/api/v1/team/invites')
      .set('Authorization', `Bearer ${await token('act')}`)
      .send({ email: 'new-agent@example.com', name: 'New', roleKey: 'agent' });
    expect(act.body.error?.code).not.toBe('AUTH_IMPERSONATION_BLOCKED');
  });

  it('/auth/me tells the mode, who and where Back goes', async () => {
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await token('act', 'reseller')}`);
    expect(me.body.data.impersonation).toMatchObject({
      mode: 'act',
      kind: 'reseller',
      returnTo: `/reseller/customers/${customer.account._id.toString()}`,
    });
    const view = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await token('view')}`);
    expect(view.body.data.impersonation).toMatchObject({ mode: 'view', kind: 'superadmin' });
  });
});

describe('reseller login as (T19.3)', () => {
  const fakeReq = (accountId: string, userId: string, extra: Record<string, unknown> = {}) =>
    ({
      auth: { kind: 'user', accountId, userId, permissions: new Set(), ...extra },
      ip: '127.0.0.1',
    }) as unknown as Request;

  it('only its own customers, approved reseller, never nested; audited both sides', async () => {
    const reseller = await createTestAccount({
      kind: 'reseller',
      reseller: {
        status: 'active',
        customersCanTopUp: false,
        approvedAt: null,
        approvedBy: null,
        brand: null,
      },
    });
    const rUser = await reseller.addUser('owner');
    const mine = await createTestAccount({ parentAccountId: reseller.account._id });
    await mine.addUser('owner');
    const req = fakeReq(reseller.account._id.toString(), rUser.user._id.toString());
    const session = await loginAsCustomer(req, mine.account._id.toString());
    expect(session.impersonation).toMatchObject({ mode: 'act', kind: 'reseller' });
    expect(session.account.id).toBe(mine.account._id.toString());
    expect(
      await AuditLogModel.countDocuments({
        action: 'reseller.login_as_started',
        accountId: { $in: [reseller.account._id, mine.account._id] },
      }),
    ).toBe(2);
    // someone else's customer / a direct business → 404
    await expect(loginAsCustomer(req, customer.account._id.toString())).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    // nested
    await expect(
      loginAsCustomer(
        fakeReq(reseller.account._id.toString(), rUser.user._id.toString(), {
          impersonatorId: ownerId,
        }),
        mine.account._id.toString(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
    // a business account is not a reseller → 404
    await expect(
      loginAsCustomer(
        fakeReq(customer.account._id.toString(), ownerId),
        mine.account._id.toString(),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('a pending reseller cannot log in as customers', async () => {
    const pending = await createTestAccount({
      kind: 'reseller',
      reseller: {
        status: 'pending_approval',
        customersCanTopUp: false,
        approvedAt: null,
        approvedBy: null,
        brand: null,
      },
    });
    const u = await pending.addUser('owner');
    const child = await createTestAccount({ parentAccountId: pending.account._id });
    await expect(
      loginAsCustomer(
        fakeReq(pending.account._id.toString(), u.user._id.toString()),
        child.account._id.toString(),
      ),
    ).rejects.toMatchObject({ code: 'RESELLER_NOT_APPROVED' });
  });
});
