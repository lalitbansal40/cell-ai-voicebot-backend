import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import { getEmail } from '../../core/email';
import { notifyAccount, notifyUser } from '../../core/realtime/notify';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { RoleModel, type RoleDoc } from '../../db/models/role.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { withTransaction } from '../../db/transaction';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyAttemptsError,
  UnauthenticatedError,
  ValidationError,
} from '../../shared/errors/app-error';
import { auditRequest, recordAudit } from '../audit/audit.service';
import { INVITE_TTL_MS } from '../auth/auth.constants';
import { hmacToken, randomToken } from '../auth/hmac';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/refresh.service';
import { startSession, type AuthSession } from '../auth/session';

import type { InviteBody, ListMembersQuery, UpdateMemberBody } from './team.schema';

const INVITE_RESEND_COOLDOWN_MS = 60_000;

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: UserDoc['status'];
  role: { key: string; name: string };
  isOwner: boolean;
  lastLoginAt: string | null;
  inviteExpiresAt: string | null;
  createdAt: string;
}

const frontendUrl = (path: string) => `${getEnv().FRONTEND_URL.replace(/\/+$/, '')}${path}`;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const accountRoles = async (accountId: Types.ObjectId) => {
  const roles = await RoleModel.find({ accountId }).lean<RoleDoc[]>();
  return {
    byId: new Map(roles.map((r) => [r._id.toString(), r])),
    byKey: new Map(roles.map((r) => [r.key, r])),
  };
};

const toMember = (user: UserDoc, role: RoleDoc | undefined): TeamMember => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  phone: user.phone ?? null,
  status: user.status,
  role: { key: role?.key ?? 'unknown', name: role?.name ?? 'Unknown' },
  isOwner: role?.key === 'owner',
  lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  inviteExpiresAt: user.invite ? user.invite.expiresAt.toISOString() : null,
  createdAt: user.createdAt.toISOString(),
});

/** Member of the caller's account, or 404 (other accounts' users don't exist for you). */
const findMember = async (req: Request, id: string): Promise<UserDoc> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const user = await UserModel.findOne({ _id, ...tenantFilter(req) }).lean<UserDoc>();
  if (!user) throw new NotFoundError();
  return user;
};

const sendInvite = async (
  user: Pick<UserDoc, '_id' | 'email'>,
  ctx: { inviterName: string; accountName: string; roleName: string },
  token: string,
) =>
  getEmail().enqueue(
    'team.invite',
    user.email,
    {
      ...ctx,
      acceptUrl: frontendUrl(`/accept-invite?token=${encodeURIComponent(token)}`),
      days: INVITE_TTL_MS / 86_400_000,
    },
    { dedupeKey: `invite:${user._id.toString()}:${Date.now()}` },
  );

export const listMembers = async (
  req: Request,
  query: z.infer<typeof ListMembersQuery>,
): Promise<{
  items: TeamMember[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}> => {
  const { accountId } = tenantFilter(req);
  const roles = await accountRoles(accountId);
  const filter: Record<string, unknown> = { accountId };
  if (query.status) filter.status = query.status;
  if (query.roleKey) filter.roleId = roles.byKey.get(query.roleKey)?._id ?? new Types.ObjectId();
  if (query.search) {
    const re = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ name: re }, { email: re }];
  }
  const [users, total] = await Promise.all([
    UserModel.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<UserDoc[]>(),
    UserModel.countDocuments(filter),
  ]);
  return {
    items: users.map((u) => toMember(u, roles.byId.get(u.roleId.toString()))),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

const callerIsOwner = (req: Request) => requireAuth(req).roleKey === 'owner';

export const invite = async (
  req: Request,
  body: z.infer<typeof InviteBody>,
): Promise<TeamMember> => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  if (body.roleKey === 'admin' && !callerIsOwner(req)) {
    throw new ForbiddenError('Only the owner can invite admins.');
  }
  const email = body.email.trim().toLowerCase();
  if (await UserModel.exists({ email })) {
    throw new ConflictError('CONFLICT_DUPLICATE', "This email can't be invited.");
  }
  const roles = await accountRoles(accountId);
  const role = roles.byKey.get(body.roleKey);
  if (!role) throw new AppError('INTERNAL_ERROR', 'System role missing');
  const token = randomToken();
  const now = new Date();
  const user = await UserModel.create({
    accountId,
    roleId: role._id,
    name: body.name,
    email,
    status: 'invited',
    passwordHash: null,
    invite: {
      tokenHash: hmacToken(token),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      invitedBy: new Types.ObjectId(auth.userId),
      lastSentAt: now,
    },
  });
  const [account, inviter] = await Promise.all([
    AccountModel.findById(accountId).lean<AccountDoc>(),
    UserModel.findById(auth.userId).lean<UserDoc>(),
  ]);
  await sendInvite(
    user,
    {
      inviterName: inviter?.name ?? 'Your team',
      accountName: account?.name ?? '',
      roleName: role.name,
    },
    token,
  );
  await auditRequest(req, 'team.invited', {
    target: { type: 'user', id: user._id.toString() },
    meta: { roleKey: role.key },
  });
  notifyAccount(auth.accountId, 'team.changed');
  return toMember(user.toObject({ transform: false }), role);
};

export const resendInvite = async (req: Request, userId: string): Promise<void> => {
  const user = await findMember(req, userId);
  if (user.status !== 'invited' || !user.invite) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This member has no pending invitation.');
  }
  const since = Date.now() - user.invite.lastSentAt.getTime();
  if (since < INVITE_RESEND_COOLDOWN_MS) {
    throw new TooManyAttemptsError((INVITE_RESEND_COOLDOWN_MS - since) / 1000);
  }
  const roles = await accountRoles(user.accountId);
  const role = roles.byId.get(user.roleId.toString());
  if (role?.key === 'admin' && !callerIsOwner(req)) throw new ForbiddenError();
  const token = randomToken();
  const now = new Date();
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        'invite.tokenHash': hmacToken(token),
        'invite.expiresAt': new Date(now.getTime() + INVITE_TTL_MS),
        'invite.lastSentAt': now,
      },
    },
  );
  const [account, inviter] = await Promise.all([
    AccountModel.findById(user.accountId).lean<AccountDoc>(),
    UserModel.findById(requireAuth(req).userId).lean<UserDoc>(),
  ]);
  await sendInvite(
    user,
    {
      inviterName: inviter?.name ?? 'Your team',
      accountName: account?.name ?? '',
      roleName: role?.name ?? '',
    },
    token,
  );
  await auditRequest(req, 'team.invite_resent', { target: { type: 'user', id: userId } });
};

export const revokeInvite = async (req: Request, userId: string): Promise<void> => {
  const user = await findMember(req, userId);
  if (user.status !== 'invited') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This member has no pending invitation.');
  }
  const role = (await accountRoles(user.accountId)).byId.get(user.roleId.toString());
  if (role?.key === 'admin' && !callerIsOwner(req)) throw new ForbiddenError();
  await UserModel.deleteOne({ _id: user._id, status: 'invited' });
  await auditRequest(req, 'team.invite_revoked', {
    target: { type: 'user', id: userId },
    meta: { email: user.email },
  });
  notifyAccount(requireAuth(req).accountId, 'team.changed');
};

/** Pending invitation by token (unknown / used / expired → AUTH_CODE_INVALID). */
const findInvite = async (token: string): Promise<UserDoc> => {
  const user = await UserModel.findOne({
    'invite.tokenHash': hmacToken(token),
    status: 'invited',
  }).lean<UserDoc>();
  if (!user?.invite || user.invite.expiresAt.getTime() <= Date.now()) {
    throw new AppError('AUTH_CODE_INVALID');
  }
  return user;
};

export const inviteInfo = async (token: string) => {
  const user = await findInvite(token);
  const [account, role, inviter] = await Promise.all([
    AccountModel.findById(user.accountId).lean<AccountDoc>(),
    RoleModel.findById(user.roleId).lean<RoleDoc>(),
    UserModel.findById(user.invite?.invitedBy).lean<UserDoc>(),
  ]);
  return {
    email: user.email,
    name: user.name,
    accountName: account?.name ?? '',
    inviterName: inviter?.name ?? '',
    roleName: role?.name ?? '',
  };
};

export const acceptInvite = async (
  req: Request,
  res: Response,
  body: { token: string; password: string; name?: string },
): Promise<AuthSession> => {
  const user = await findInvite(body.token);
  const name = body.name ?? user.name;
  const issues = validatePasswordPolicy(
    body.password,
    { email: user.email, name },
    'body.password',
  );
  if (issues.length) throw new ValidationError(issues);
  const updated = await UserModel.updateOne(
    { _id: user._id, status: 'invited', 'invite.tokenHash': hmacToken(body.token) },
    {
      $set: {
        name,
        passwordHash: await hashPassword(body.password),
        status: 'active',
        emailVerifiedAt: new Date(),
        lastLoginAt: new Date(),
        invite: null,
      },
    },
  );
  if (updated.modifiedCount !== 1) throw new AppError('AUTH_CODE_INVALID');
  await recordAudit({
    accountId: user.accountId,
    actor: { type: 'user', id: user._id },
    action: 'team.invite_accepted',
    target: { type: 'user', id: user._id.toString() },
    ip: req.ip ?? null,
  });
  notifyAccount(user.accountId.toString(), 'team.changed');
  return startSession(req, res, user._id);
};

/** Shared guards for changing / removing a member. */
const assertCanManage = (req: Request, target: UserDoc, targetRole: RoleDoc | undefined) => {
  const auth = requireAuth(req);
  if (target._id.toString() === auth.userId) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'You cannot change your own membership here.',
    );
  }
  if (targetRole?.key === 'owner') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The owner cannot be changed. Transfer ownership first.',
    );
  }
  if (targetRole?.key === 'admin' && auth.roleKey !== 'owner') {
    throw new ForbiddenError('Only the owner can manage admins.');
  }
};

export const updateMember = async (
  req: Request,
  id: string,
  body: z.infer<typeof UpdateMemberBody>,
): Promise<TeamMember> => {
  const auth = requireAuth(req);
  const target = await findMember(req, id);
  const roles = await accountRoles(target.accountId);
  const currentRole = roles.byId.get(target.roleId.toString());
  assertCanManage(req, target, currentRole);

  const $set: Record<string, unknown> = {};
  let bumpVersion = false;
  let changedRole: RoleDoc | undefined;
  if (body.roleKey && body.roleKey !== currentRole?.key) {
    if (body.roleKey === 'admin' && auth.roleKey !== 'owner') {
      throw new ForbiddenError('Only the owner can make admins.');
    }
    changedRole = roles.byKey.get(body.roleKey);
    if (!changedRole) throw new AppError('INTERNAL_ERROR', 'System role missing');
    $set.roleId = changedRole._id;
    bumpVersion = true;
  }
  let statusChange: 'enabled' | 'disabled' | undefined;
  if (body.status && body.status !== target.status) {
    if (target.status === 'invited') {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'Pending invitations can only be resent or revoked.',
      );
    }
    $set.status = body.status;
    statusChange = body.status === 'disabled' ? 'disabled' : 'enabled';
    if (statusChange === 'disabled') bumpVersion = true;
  }

  if (Object.keys($set).length || bumpVersion) {
    await UserModel.updateOne(
      { _id: target._id },
      {
        ...(Object.keys($set).length ? { $set } : {}),
        ...(bumpVersion ? { $inc: { tokenVersion: 1 } } : {}),
      },
    );
  }
  const accountId = target.accountId.toString();
  const userId = target._id.toString();
  if (changedRole) {
    await auditRequest(req, 'team.role_changed', {
      target: { type: 'user', id: userId },
      meta: { from: currentRole?.key ?? null, to: changedRole.key },
    });
    notifyUser(accountId, userId, 'user.updated', { userId });
  }
  if (statusChange === 'disabled') {
    await revokeAllForUser(target._id, 'disabled');
    notifyUser(accountId, userId, 'session.revoked', { reason: 'disabled' }, { close: true });
    await auditRequest(req, 'team.disabled', { target: { type: 'user', id: userId } });
  } else if (statusChange === 'enabled') {
    await auditRequest(req, 'team.enabled', { target: { type: 'user', id: userId } });
  }
  if (changedRole || statusChange) notifyAccount(accountId, 'team.changed');

  const fresh = await UserModel.findById(target._id).lean<UserDoc>();
  if (!fresh) throw new NotFoundError();
  return toMember(fresh, roles.byId.get(fresh.roleId.toString()));
};

export const removeMember = async (req: Request, id: string): Promise<void> => {
  const target = await findMember(req, id);
  const roles = await accountRoles(target.accountId);
  assertCanManage(req, target, roles.byId.get(target.roleId.toString()));
  await UserModel.updateOne(
    { _id: target._id },
    { $set: { deletedAt: new Date(), invite: null }, $inc: { tokenVersion: 1 } },
  );
  await revokeAllForUser(target._id, 'removed');
  const accountId = target.accountId.toString();
  notifyUser(
    accountId,
    target._id.toString(),
    'session.revoked',
    { reason: 'removed' },
    { close: true },
  );
  await auditRequest(req, 'team.removed', {
    target: { type: 'user', id: target._id.toString() },
    meta: { email: target.email },
  });
  notifyAccount(accountId, 'team.changed');
};

/**
 * Owner only: the target (an active admin) becomes owner, the old owner
 * becomes admin. Re-authenticates with the owner's password.
 */
export const transferOwnership = async (
  req: Request,
  body: { userId: string; password: string },
): Promise<{ ownerId: string }> => {
  const auth = requireAuth(req);
  if (auth.roleKey !== 'owner') throw new ForbiddenError('Only the owner can transfer ownership.');
  const me = await UserModel.findById(auth.userId).lean<UserDoc>();
  if (!me?.passwordHash || !(await verifyPassword(me.passwordHash, body.password)).ok) {
    throw new UnauthenticatedError('AUTH_INVALID_CREDENTIALS');
  }
  const target = await findMember(req, body.userId);
  if (target._id.toString() === auth.userId) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'You already own this account.');
  }
  const roles = await accountRoles(target.accountId);
  if (target.status !== 'active' || roles.byId.get(target.roleId.toString())?.key !== 'admin') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Ownership can only go to an active admin.');
  }
  const ownerRole = roles.byKey.get('owner');
  const adminRole = roles.byKey.get('admin');
  if (!ownerRole || !adminRole) throw new AppError('INTERNAL_ERROR', 'System role missing');

  await withTransaction(async (session) => {
    await UserModel.updateOne(
      { _id: target._id },
      { $set: { roleId: ownerRole._id }, $inc: { tokenVersion: 1 } },
      { session },
    );
    await UserModel.updateOne(
      { _id: me._id },
      { $set: { roleId: adminRole._id }, $inc: { tokenVersion: 1 } },
      { session },
    );
    await AccountModel.updateOne(
      { _id: target.accountId },
      { $set: { ownerId: target._id } },
      { session },
    );
  });
  const accountId = target.accountId.toString();
  await auditRequest(req, 'account.ownership_transferred', {
    target: { type: 'user', id: target._id.toString() },
    meta: { from: auth.userId, to: target._id.toString() },
  });
  notifyUser(accountId, target._id.toString(), 'user.updated', { userId: target._id.toString() });
  notifyUser(accountId, me._id.toString(), 'user.updated', { userId: me._id.toString() });
  notifyAccount(accountId, 'team.changed');
  return { ownerId: target._id.toString() };
};
