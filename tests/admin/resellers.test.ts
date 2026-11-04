import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const PASSWORD = 'green-falcon-lake-77';

let superadmin: TestUser;
let owner: TestUser;
let n = 0;

beforeAll(async () => {
  const platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-r-${String(Date.now())}`,
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  const someone = await createTestAccount();
  owner = await someone.addUser('owner');
});

const send = (
  method: 'get' | 'post' | 'patch' | 'put',
  url: string,
  body: object = {},
  u = superadmin,
) =>
  request(app)[method](`/api/v1/admin${url}`).set('Authorization', `Bearer ${u.token}`).send(body);

const create = (body: Record<string, unknown> = {}) =>
  send('post', '/accounts', {
    businessName: `Biz ${String(++n)}`,
    ownerName: 'Owner',
    ownerEmail: `owner-r${String(n)}-${String(Date.now())}@example.com`,
    ownerPassword: PASSWORD,
    ...body,
  });

describe('superadmin: resellers (T19.4)', () => {
  it('creates a reseller and a business under it; a parent must be a reseller', async () => {
    const r = await create({ kind: 'reseller' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ kind: 'reseller', reseller: { status: 'active' } });
    const b = await create({ parentAccountId: r.body.data.id });
    expect(b.body.data).toMatchObject({ kind: 'business', parentAccountId: r.body.data.id });
    const notReseller = await create({ parentAccountId: b.body.data.id });
    expect(notReseller.status).toBe(422);
    const resellerUnder = await create({ kind: 'reseller', parentAccountId: r.body.data.id });
    expect(resellerUnder.status).toBe(422);
    const list = await send('get', `/accounts?kind=reseller`);
    const row = list.body.data.find((a: { id: string }) => a.id === r.body.data.id);
    expect(row).toMatchObject({ kind: 'reseller', customersCount: 1, resellerStatus: 'active' });
    const children = await send('get', `/accounts?parentAccountId=${String(r.body.data.id)}`);
    expect(children.body.data).toHaveLength(1);
    expect(children.body.data[0]).toMatchObject({ parent: { id: r.body.data.id } });
  });

  it('moves a business between resellers and back to direct (audited)', async () => {
    const r1 = (await create({ kind: 'reseller' })).body.data.id as string;
    const r2 = (await create({ kind: 'reseller' })).body.data.id as string;
    const b = (await create()).body.data.id as string;
    expect(
      (await send('patch', `/accounts/${b}/reseller`, { parentAccountId: r1 })).body.data
        .parentAccountId,
    ).toBe(r1);
    await send('patch', `/accounts/${b}/reseller`, { parentAccountId: r2 });
    expect(
      (await send('patch', `/accounts/${b}/reseller`, { parentAccountId: null })).body.data
        .parentAccountId,
    ).toBeNull();
    const audits = await AuditLogModel.find({
      action: 'account.reseller_changed',
      accountId: b,
    }).lean();
    expect(audits.map((a) => a.meta)).toEqual(
      expect.arrayContaining([
        { from: r1, to: r2 },
        { from: r2, to: null },
      ]),
    );
    expect((await send('patch', `/accounts/${r1}/reseller`, { parentAccountId: r2 })).status).toBe(
      409,
    );
    expect((await send('patch', `/accounts/${b}/reseller`, { parentAccountId: b })).status).toBe(
      422,
    );
  });

  it('approves a pending reseller and rings its owners; twice → 409', async () => {
    const r = (await create({ kind: 'reseller' })).body.data.id as string;
    await AccountModel.updateOne({ _id: r }, { $set: { 'reseller.status': 'pending_approval' } });
    const ok = await send('post', `/accounts/${r}/approve-reseller`);
    expect(ok.body.data.reseller.status).toBe('active');
    expect(
      await NotificationModel.countDocuments({ type: 'reseller.approved', accountId: r }),
    ).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'reseller.approved', accountId: r })).toBe(
      1,
    );
    expect((await send('post', `/accounts/${r}/approve-reseller`)).status).toBe(409);
  });

  it('suspends all customers of a reseller, not the reseller', async () => {
    const r = (await create({ kind: 'reseller' })).body.data.id as string;
    await create({ parentAccountId: r });
    await create({ parentAccountId: r });
    const res = await send('post', `/accounts/${r}/suspend-customers`, {
      reason: 'Unpaid invoices',
    });
    expect(res.body.data).toEqual({ suspended: 2 });
    expect(await AccountModel.countDocuments({ parentAccountId: r, status: 'suspended' })).toBe(2);
    expect((await AccountModel.findById(r).lean())?.status).toBe('active');
  });

  it('signup settings: read, write (validated, audited); superadmin only', async () => {
    expect((await send('get', '/settings/signup')).body.data).toEqual({
      open: true,
      resellerSignup: 'open',
    });
    const put = await send('put', '/settings/signup', { open: true, resellerSignup: 'approval' });
    expect(put.body.data).toEqual({ open: true, resellerSignup: 'approval' });
    expect(
      (await send('put', '/settings/signup', { open: true, resellerSignup: 'maybe' })).status,
    ).toBe(422);
    expect(await AuditLogModel.countDocuments({ action: 'platform.signup_settings_updated' })).toBe(
      1,
    );
    expect((await send('get', '/settings/signup', {}, owner)).status).toBe(403);
    await send('put', '/settings/signup', { open: true, resellerSignup: 'open' });
  });
});
