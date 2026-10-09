import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as notifyModule from '../../src/core/realtime/notify';
import { AccountModel } from '../../src/db/models/account.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { UserModel } from '../../src/db/models/user.model';
import {
  notify,
  notifyPlatform,
  purgeNotifications,
  superadmins,
  usersWithPermission,
} from '../../src/modules/notifications/notifications.service';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

let t: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let agent: TestUser;
let disabledAdmin: TestUser;

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  viewer = await t.addUser('viewer');
  agent = await t.addUser('agent');
  disabledAdmin = await t.addUser('admin', { status: 'disabled' });
});

describe('notify', () => {
  it('fans out one row per user with the permission and pushes WS events', async () => {
    const push = vi.spyOn(notifyModule, 'notifyUser');
    const n = await notify({
      accountId: t.account._id,
      permission: 'wallet.read',
      type: 'wallet.low_balance',
      title: 'Wallet balance is low',
      body: '₹100.00 available',
      link: '/wallet',
    });
    expect(n).toBe(2); // owner + viewer (agent lacks wallet.read; the admin is disabled)
    const rows = await NotificationModel.find({ accountId: t.account._id }).lean();
    expect(rows.map((r) => r.userId.toString()).sort()).toEqual(
      [owner.user._id.toString(), viewer.user._id.toString()].sort(),
    );
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0]?.[2]).toBe('notification.created');
    push.mockRestore();
    expect(
      (await usersWithPermission(t.account._id, 'wallet.topup')).map((u) => u.userId.toString()),
    ).toEqual([owner.user._id.toString()]);
    expect(disabledAdmin.user.status).toBe('disabled');
  });

  it('accepts explicit users, truncates long text, returns 0 when nobody matches', async () => {
    expect(
      await notify({
        accountId: t.account._id,
        userIds: [agent.user._id],
        type: 'wallet.adjusted',
        title: 'x'.repeat(200),
        body: 'y'.repeat(900),
      }),
    ).toBe(1);
    const row = await NotificationModel.findOne({ userId: agent.user._id }).lean();
    expect(row?.title).toHaveLength(120);
    expect(row?.body).toHaveLength(500);
    expect(row?.link).toBeNull();
    expect(
      await notify({
        accountId: t.account._id,
        permission: 'nobody.has.this',
        type: 'wallet.adjusted',
        title: 't',
        body: 'b',
      }),
    ).toBe(0);
    expect(
      await notify({ accountId: t.account._id, type: 'wallet.adjusted', title: 't', body: 'b' }),
    ).toBe(0);
  });

  it('never throws (logs and returns 0)', async () => {
    vi.spyOn(NotificationModel, 'insertMany').mockRejectedValueOnce(new Error('db down'));
    expect(
      await notify({
        accountId: t.account._id,
        userIds: [owner.user._id],
        type: 'wallet.adjusted',
        title: 't',
        body: 'b',
      }),
    ).toBe(0);
  });

  it('reaches superadmins in the platform account', async () => {
    expect((await superadmins()).users).toEqual([]);
    expect(
      await notifyPlatform({ type: 'billing.reconcile_mismatch', title: 't', body: 'b' }),
    ).toBe(0);
    const platform = await AccountModel.create({
      name: 'Platform',
      slug: 'platform-n',
      isPlatform: true,
    });
    const root = await UserModel.create({
      accountId: platform._id,
      roleId: new Types.ObjectId(),
      name: 'Root',
      email: 'root-n@platform.local',
      status: 'active',
      platformRole: 'superadmin',
    });
    expect(
      await notifyPlatform({ type: 'billing.reconcile_mismatch', title: 'Mismatch', body: 'b' }),
    ).toBe(1);
    expect(
      (await NotificationModel.findOne({ userId: root._id }).lean())?.accountId.toString(),
    ).toBe(platform._id.toString());
  });

  it('purges expired rows', async () => {
    await NotificationModel.create({
      accountId: t.account._id,
      userId: owner.user._id,
      type: 'wallet.adjusted',
      title: 'old',
      body: 'old',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await purgeNotifications()).deleted).toBeGreaterThanOrEqual(1);
  });
});

describe('notifications API', () => {
  it('lists my notifications newest first, unread filter, counts, read, read-all', async () => {
    const u = await t.addUser('manager');
    for (let i = 0; i < 3; i += 1) {
      await notify({
        accountId: t.account._id,
        userIds: [u.user._id],
        type: 'wallet.adjusted',
        title: `n${i}`,
        body: 'b',
      });
    }
    const list = await request(app).get('/api/v1/notifications?limit=2').set(auth(u));
    expect(list.status).toBe(200);
    expect(list.body.data.map((n: { title: string }) => n.title)).toEqual(['n2', 'n1']);
    expect(list.body.meta.hasMore).toBe(true);
    const next = await request(app)
      .get(`/api/v1/notifications?limit=2&cursor=${list.body.meta.nextCursor as string}`)
      .set(auth(u));
    expect(next.body.data.map((n: { title: string }) => n.title)).toEqual(['n0']);
    expect(
      (await request(app).get('/api/v1/notifications/unread-count').set(auth(u))).body.data,
    ).toEqual({ count: 3 });

    const id = list.body.data[0].id as string;
    const read = await request(app).post(`/api/v1/notifications/${id}/read`).set(auth(u));
    expect(read.body.data.readAt).toMatch(/Z$/);
    const again = await request(app).post(`/api/v1/notifications/${id}/read`).set(auth(u));
    expect(again.body.data.readAt).toBe(read.body.data.readAt); // first read time kept
    const unread = await request(app).get('/api/v1/notifications?unread=true').set(auth(u));
    expect(unread.body.data).toHaveLength(2);
    expect(
      (await request(app).post('/api/v1/notifications/read-all').set(auth(u))).body.data,
    ).toEqual({ updated: 2 });
    expect(
      (await request(app).get('/api/v1/notifications/unread-count').set(auth(u))).body.data.count,
    ).toBe(0);
  });

  it('never shows or changes another user’s notification', async () => {
    const mine = await NotificationModel.findOne({ userId: owner.user._id }).lean();
    const id = mine?._id.toString() ?? '';
    expect(
      (await request(app).post(`/api/v1/notifications/${id}/read`).set(auth(agent))).status,
    ).toBe(404);
    const list = await request(app).get('/api/v1/notifications').set(auth(agent));
    expect(list.body.data.map((n: { id: string }) => n.id)).not.toContain(id);
    expect(
      (await request(app).get('/api/v1/notifications?unread=maybe').set(auth(agent))).status,
    ).toBe(422);
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401);
  });
});
