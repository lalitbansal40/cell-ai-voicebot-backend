import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeAllRedis } from '../../src/core/queues/redis';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { RefreshTokenModel } from '../../src/db/models/refresh-token.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import {
  createTestAccount,
  TEST_PASSWORD,
  tokenFor,
  type TestAccount,
  type TestUser,
} from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { lastEmail, useCapturedEmail } from '../helpers/email';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const app = buildTestApp({}, { authRateLimit: { limit: 10_000 } });
const NEW_PASSWORD = 'green-falcon-lake-77';
let n = 0;
const newEmail = () => `invitee${++n}-${Date.now()}@example.com`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let t: TestAccount;
let owner: TestUser;
let admin: TestUser;

beforeAll(async () => {
  await requireRedis();
  t = await createTestAccount();
  owner = await t.addUser('owner');
  admin = await t.addUser('admin');
});
afterAll(async () => {
  await closeAllRedis();
});

const inviteAs = (token: string, body: object) =>
  request(app).post('/api/v1/team/invites').set(auth(token)).send(body);
const tokenOf = (email: string) =>
  new URL(String(lastEmail(sent, 'team.invite', email)?.vars.acceptUrl)).searchParams.get(
    'token',
  ) ?? '';
const patchMember = (token: string, id: string, body: object) =>
  request(app).patch(`/api/v1/team/users/${id}`).set(auth(token)).send(body);
const roleKeyOf = async (userId: unknown) => {
  const user = await UserModel.findById(userId).lean();
  return (await RoleModel.findById(user?.roleId).lean())?.key;
};

describe('invite → accept', () => {
  it('invites, emails a link, and the invitee signs in by accepting', async () => {
    const email = newEmail();
    const res = await inviteAs(admin.token, { email, name: 'New Manager', roleKey: 'manager' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      email,
      status: 'invited',
      role: { key: 'manager', name: 'Manager' },
      isOwner: false,
    });
    expect(res.body.data.inviteExpiresAt).toBeTruthy();
    const mail = lastEmail(sent, 'team.invite', email);
    expect(mail?.vars).toMatchObject({
      inviterName: admin.user.name,
      accountName: t.account.name,
      roleName: 'Manager',
      days: 7,
    });
    expect(String(mail?.vars.acceptUrl)).toMatch(
      /^http:\/\/localhost:3100\/accept-invite\?token=[\w-]{43}$/,
    );

    const token = tokenOf(email);
    const info = await request(app).get('/api/v1/auth/invite-info').query({ token });
    expect(info.body.data).toEqual({
      email,
      name: 'New Manager',
      accountName: t.account.name,
      inviterName: admin.user.name,
      roleName: 'Manager',
    });

    const accepted = await request(app)
      .post('/api/v1/auth/accept-invite')
      .send({ token, password: NEW_PASSWORD, name: 'Manager Renamed' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.user).toMatchObject({
      email,
      name: 'Manager Renamed',
      status: 'active',
    });
    expect(accepted.body.data.role.key).toBe('manager');
    expect(String(accepted.headers['set-cookie'])).toContain('cav_rt=');

    const stored = await UserModel.findOne({ email }).lean();
    expect(stored?.invite).toBeNull();
    expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/accept-invite')
          .send({ token, password: NEW_PASSWORD })
      ).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
    expect(
      (await request(app).post('/api/v1/auth/login').send({ email, password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
    expect(
      await AuditLogModel.countDocuments({ accountId: t.account._id, action: 'team.invited' }),
    ).toBeGreaterThan(0);
    expect(
      await AuditLogModel.countDocuments({
        accountId: t.account._id,
        action: 'team.invite_accepted',
        'actor.id': stored?._id,
      }),
    ).toBe(1);
  });

  it('rejects duplicate emails (any account), owner role and admin invites by non-owners', async () => {
    const dup = await inviteAs(admin.token, {
      email: owner.user.email,
      name: 'X',
      roleKey: 'viewer',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe("This email can't be invited.");
    const other = await createTestAccount();
    const foreign = await other.addUser('viewer');
    expect(
      (await inviteAs(admin.token, { email: foreign.user.email, name: 'X', roleKey: 'viewer' }))
        .status,
    ).toBe(409);
    expect(
      (await inviteAs(owner.token, { email: newEmail(), name: 'X', roleKey: 'owner' })).status,
    ).toBe(422);
    expect(
      (await inviteAs(admin.token, { email: newEmail(), name: 'X', roleKey: 'admin' })).status,
    ).toBe(403);
    expect(
      (await inviteAs(owner.token, { email: newEmail(), name: 'X', roleKey: 'admin' })).status,
    ).toBe(201);
  });

  it('rejects expired invites and weak passwords (without burning the link)', async () => {
    const email = newEmail();
    await inviteAs(owner.token, { email, name: 'Viewer', roleKey: 'viewer' });
    const token = tokenOf(email);
    const weak = await request(app)
      .post('/api/v1/auth/accept-invite')
      .send({ token, password: 'short' });
    expect(weak.status).toBe(422);
    await UserModel.updateOne(
      { email },
      { $set: { 'invite.expiresAt': new Date(Date.now() - 1000) } },
    );
    expect(
      (await request(app).get('/api/v1/auth/invite-info').query({ token })).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
    expect(
      (
        await request(app)
          .post('/api/v1/auth/accept-invite')
          .send({ token, password: NEW_PASSWORD })
      ).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
  });

  it('resend issues a new link (old one dies) with a 60 s cooldown; revoke deletes the invite', async () => {
    const email = newEmail();
    const res = await inviteAs(owner.token, { email, name: 'Agent', roleKey: 'agent' });
    const id = String(res.body.data.id);
    const first = tokenOf(email);
    const early = await request(app)
      .post(`/api/v1/team/invites/${id}/resend`)
      .set(auth(owner.token));
    expect(early.status).toBe(429);
    await UserModel.updateOne(
      { email },
      { $set: { 'invite.lastSentAt': new Date(Date.now() - 120_000) } },
    );
    const resent = await request(app)
      .post(`/api/v1/team/invites/${id}/resend`)
      .set(auth(owner.token));
    expect(resent.status).toBe(202);
    const second = tokenOf(email);
    expect(second).not.toBe(first);
    expect(
      (await request(app).get('/api/v1/auth/invite-info').query({ token: first })).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
    expect(
      (await request(app).get('/api/v1/auth/invite-info').query({ token: second })).status,
    ).toBe(200);

    expect(
      (await request(app).delete(`/api/v1/team/invites/${id}`).set(auth(owner.token))).status,
    ).toBe(204);
    expect(await UserModel.countDocuments({ email })).toBe(0);
    expect(
      (await request(app).get('/api/v1/auth/invite-info').query({ token: second })).body.error.code,
    ).toBe('AUTH_CODE_INVALID');
    expect(
      (await request(app).delete(`/api/v1/team/invites/${id}`).set(auth(owner.token))).status,
    ).toBe(404);
  });

  it('resend / revoke refuse active members', async () => {
    const member = await t.addUser('viewer');
    const id = member.user._id.toString();
    expect(
      (await request(app).post(`/api/v1/team/invites/${id}/resend`).set(auth(owner.token))).status,
    ).toBe(409);
    expect(
      (await request(app).delete(`/api/v1/team/invites/${id}`).set(auth(owner.token))).status,
    ).toBe(409);
  });
});

describe('member changes', () => {
  it('changes a role: the old token dies, refresh gives the new permissions', async () => {
    const manager = await t.addUser('manager');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: manager.user.email, password: TEST_PASSWORD });
    const res = await patchMember(owner.token, manager.user._id.toString(), { roleKey: 'viewer' });
    expect(res.status).toBe(200);
    expect(res.body.data.role.key).toBe('viewer');
    expect(
      (
        await request(app)
          .get('/api/v1/auth/me')
          .set(auth(String(login.body.data.accessToken)))
      ).status,
    ).toBe(401);
    const cookie = /cav_rt=([^;]*)/.exec(String(login.headers['set-cookie']))?.[1] ?? '';
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `cav_rt=${cookie}`);
    expect(refreshed.body.data.role.key).toBe('viewer');
    expect(refreshed.body.data.permissions).not.toContain('team.read');
    const entry = await AuditLogModel.findOne({
      action: 'team.role_changed',
      'target.id': manager.user._id.toString(),
    }).lean();
    expect(entry?.meta).toEqual({ from: 'manager', to: 'viewer' });
  });

  it('disables (tokens + sessions die immediately) and enables', async () => {
    const agent = await t.addUser('agent');
    const id = agent.user._id.toString();
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: agent.user.email, password: TEST_PASSWORD });
    const res = await patchMember(admin.token, id, { status: 'disabled' });
    expect(res.body.data.status).toBe('disabled');
    expect((await request(app).get('/api/v1/auth/me').set(auth(agent.token))).status).toBe(401);
    expect(
      await RefreshTokenModel.countDocuments({ userId: agent.user._id, revokedAt: null }),
    ).toBe(0);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: agent.user.email, password: TEST_PASSWORD })
      ).body.error.code,
    ).toBe('AUTH_USER_DISABLED');
    expect((await patchMember(admin.token, id, { status: 'active' })).body.data.status).toBe(
      'active',
    );
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: agent.user.email, password: TEST_PASSWORD })
      ).status,
    ).toBe(200);
    expect(
      await AuditLogModel.countDocuments({
        action: { $in: ['team.disabled', 'team.enabled'] },
        'target.id': id,
      }),
    ).toBe(2);
  });

  it('protects the owner, yourself and admins (owner-only)', async () => {
    const ownerId = owner.user._id.toString();
    expect((await patchMember(admin.token, ownerId, { status: 'disabled' })).status).toBe(409);
    expect(
      (await patchMember(admin.token, admin.user._id.toString(), { roleKey: 'viewer' })).status,
    ).toBe(409);
    const otherAdmin = await t.addUser('admin');
    expect(
      (await patchMember(admin.token, otherAdmin.user._id.toString(), { status: 'disabled' }))
        .status,
    ).toBe(403);
    const viewer = await t.addUser('viewer');
    expect(
      (await patchMember(admin.token, viewer.user._id.toString(), { roleKey: 'admin' })).status,
    ).toBe(403);
    expect(
      (await patchMember(owner.token, viewer.user._id.toString(), { roleKey: 'admin' })).body.data
        .role.key,
    ).toBe('admin');
    expect(
      (await patchMember(owner.token, viewer.user._id.toString(), { roleKey: 'owner' })).status,
    ).toBe(422);
    expect((await patchMember(owner.token, viewer.user._id.toString(), {})).status).toBe(422);
  });

  it('refuses status changes on pending invites', async () => {
    const email = newEmail();
    const res = await inviteAs(owner.token, { email, name: 'P', roleKey: 'viewer' });
    expect(
      (await patchMember(owner.token, String(res.body.data.id), { status: 'disabled' })).status,
    ).toBe(409);
  });

  it('removes a member (soft delete, sessions end) and allows re-inviting the email', async () => {
    const viewer = await t.addUser('viewer');
    const id = viewer.user._id.toString();
    const res = await request(app).delete(`/api/v1/team/users/${id}`).set(auth(admin.token));
    expect(res.status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set(auth(viewer.token))).status).toBe(401);
    expect(await UserModel.countDocuments({ _id: viewer.user._id })).toBe(0);
    expect(
      await UserModel.countDocuments({ _id: viewer.user._id }).setOptions({ withDeleted: true }),
    ).toBe(1);
    expect(
      (await inviteAs(owner.token, { email: viewer.user.email, name: 'Back', roleKey: 'viewer' }))
        .status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .delete(`/api/v1/team/users/${owner.user._id.toString()}`)
          .set(auth(admin.token))
      ).status,
    ).toBe(409);
  });
});

describe('ownership transfer', () => {
  it('needs the owner, the password and an active admin target', async () => {
    const x = await createTestAccount();
    const o = await x.addUser('owner');
    const a = await x.addUser('admin');
    const m = await x.addUser('manager');
    const transfer = (token: string, body: object) =>
      request(app).post('/api/v1/team/transfer-ownership').set(auth(token)).send(body);
    expect(
      (await transfer(a.token, { userId: m.user._id.toString(), password: TEST_PASSWORD })).status,
    ).toBe(403);
    expect(
      (await transfer(o.token, { userId: a.user._id.toString(), password: 'wrong-password-1' }))
        .body.error.code,
    ).toBe('AUTH_INVALID_CREDENTIALS');
    expect(
      (await transfer(o.token, { userId: m.user._id.toString(), password: TEST_PASSWORD })).status,
    ).toBe(409);
    expect(
      (await transfer(o.token, { userId: o.user._id.toString(), password: TEST_PASSWORD })).status,
    ).toBe(409);

    const res = await transfer(o.token, { userId: a.user._id.toString(), password: TEST_PASSWORD });
    expect(res.body.data).toEqual({ ownerId: a.user._id.toString() });
    expect(await roleKeyOf(a.user._id)).toBe('owner');
    expect(await roleKeyOf(o.user._id)).toBe('admin');
    expect((await AccountModel.findById(x.account._id).lean())?.ownerId?.toString()).toBe(
      a.user._id.toString(),
    );
    expect((await request(app).get('/api/v1/auth/me').set(auth(o.token))).status).toBe(401);
    expect(
      await AuditLogModel.countDocuments({
        accountId: x.account._id,
        action: 'account.ownership_transferred',
      }),
    ).toBe(1);
  });
});

describe('listing + permissions + isolation', () => {
  it('lists members with filters, search (regex-safe) and pagination', async () => {
    const x = await createTestAccount();
    const o = await x.addUser('owner');
    for (const r of ['manager', 'agent', 'agent', 'viewer'] as const) await x.addUser(r);
    await x.addUser('viewer', { name: 'Zed (a+b)*', email: `zed-${Date.now()}@example.com` });
    const list = (q: Record<string, string | number>) =>
      request(app).get('/api/v1/team/users').query(q).set(auth(o.token));
    const all = await list({});
    expect(all.body.meta).toEqual({ page: 1, limit: 20, total: 6, totalPages: 1 });
    expect(all.body.data[0].isOwner).toBe(true);
    expect((await list({ roleKey: 'agent' })).body.data).toHaveLength(2);
    expect(
      (await list({ search: '(a+b)*' })).body.data.map((m: { name: string }) => m.name),
    ).toEqual(['Zed (a+b)*']);
    const page2 = await list({ limit: 4, page: 2 });
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.meta).toEqual({ page: 2, limit: 4, total: 6, totalPages: 2 });
    expect((await list({ limit: 500 })).status).toBe(422);
    expect(JSON.stringify(all.body)).not.toMatch(/passwordHash|tokenHash|tokenVersion/);
  });

  it('applies the role matrix to every team route', async () => {
    const x = await createTestAccount();
    await x.addUser('owner');
    const target = await x.addUser('viewer');
    const id = target.user._id.toString();
    const expectations: Record<string, Record<string, number>> = {
      manager: { list: 200, invite: 403, patch: 403, remove: 403 },
      agent: { list: 403, invite: 403, patch: 403, remove: 403 },
      viewer: { list: 403, invite: 403, patch: 403, remove: 403 },
    };
    for (const [role, codes] of Object.entries(expectations)) {
      const u = await x.addUser(role as 'manager');
      expect((await request(app).get('/api/v1/team/users').set(auth(u.token))).status).toBe(
        codes.list,
      );
      expect(
        (await inviteAs(u.token, { email: newEmail(), name: 'N', roleKey: 'viewer' })).status,
      ).toBe(codes.invite);
      expect((await patchMember(u.token, id, { roleKey: 'agent' })).status).toBe(codes.patch);
      expect(
        (await request(app).delete(`/api/v1/team/users/${id}`).set(auth(u.token))).status,
      ).toBe(codes.remove);
    }
  });

  it('never touches members of another account (404)', async () => {
    const other = await createTestAccount();
    const stranger = await other.addUser('viewer');
    const id = stranger.user._id.toString();
    expect((await patchMember(owner.token, id, { status: 'disabled' })).status).toBe(404);
    expect(
      (await request(app).delete(`/api/v1/team/users/${id}`).set(auth(owner.token))).status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/v1/team/invites/${id}/resend`).set(auth(owner.token))).status,
    ).toBe(404);
    expect((await patchMember(owner.token, 'not-an-id', { status: 'disabled' })).status).toBe(422);
  });

  it('blocks invites while impersonating', async () => {
    const imp = await tokenFor(owner.user, { sid: 'imp_t', imp: admin.user._id.toString() });
    expect(
      (await inviteAs(imp, { email: newEmail(), name: 'I', roleKey: 'viewer' })).body.error.code,
    ).toBe('AUTH_IMPERSONATION_BLOCKED');
  });
});
