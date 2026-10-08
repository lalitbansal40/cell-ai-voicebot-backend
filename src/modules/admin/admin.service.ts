import type { Request } from 'express';
import type { Types } from 'mongoose';
import type { z } from 'zod';

import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { AuditLogModel, type AuditLogDoc } from '../../db/models/audit-log.model';
import { RoleModel, type RoleDoc } from '../../db/models/role.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { IMPERSONATION_TTL } from '../auth/auth.constants';
import { randomToken } from '../auth/hmac';
import {
  accessTokenFor,
  buildSessionBody,
  toPublicAccount,
  toPublicUser,
  type AuthSession,
} from '../auth/session';

import type { ListAccountsQuery } from './admin.schema';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findCustomerAccount = async (id: string): Promise<AccountDoc> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const account = await AccountModel.findById(_id).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  if (account.isPlatform) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The platform account cannot be managed here.',
    );
  }
  return account;
};

/** Audits a superadmin action in the target account AND in the platform account. */
const auditBothSides = async (
  req: Request,
  account: AccountDoc,
  action: AuditAction,
  meta?: Record<string, unknown>,
) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
    action,
    target: { type: 'account', id: account._id.toString() },
    meta: meta ?? null,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId: account._id });
  await recordAudit({ ...base, accountId: auth.accountId });
};

export const listAccounts = async (query: z.infer<typeof ListAccountsQuery>) => {
  const filter: Record<string, unknown> = { isPlatform: { $ne: true } };
  if (query.status) filter.status = query.status;
  if (query.search) {
    const re = new RegExp(escapeRegex(query.search), 'i');
    const owners = await UserModel.find({ email: re }).select({ _id: 1 }).limit(200).lean();
    filter.$or = [{ name: re }, { slug: re }, { ownerId: { $in: owners.map((o) => o._id) } }];
  }
  const [accounts, total] = await Promise.all([
    AccountModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<AccountDoc[]>(),
    AccountModel.countDocuments(filter),
  ]);
  const ids = accounts.map((a) => a._id);
  const [owners, counts] = await Promise.all([
    UserModel.find({
      _id: { $in: accounts.flatMap((a) => (a.ownerId ? [a.ownerId] : [])) },
    })
      .select({ email: 1 })
      .lean<{ _id: Types.ObjectId; email: string }[]>(),
    UserModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { accountId: { $in: ids } } },
      { $group: { _id: '$accountId', n: { $sum: 1 } } },
    ]),
  ]);
  const ownerEmail = new Map(owners.map((o) => [o._id.toString(), o.email]));
  const userCount = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return {
    items: accounts.map((a) => ({
      id: a._id.toString(),
      name: a.name,
      slug: a.slug,
      status: a.status,
      ownerEmail: a.ownerId ? (ownerEmail.get(a.ownerId.toString()) ?? null) : null,
      usersCount: userCount.get(a._id.toString()) ?? 0,
      createdAt: a.createdAt.toISOString(),
    })),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

export const accountDetail = async (id: string) => {
  const account = await findCustomerAccount(id);
  const [owner, byStatus, recent] = await Promise.all([
    account.ownerId ? UserModel.findById(account.ownerId).lean<UserDoc>() : null,
    UserModel.aggregate<{ _id: UserDoc['status']; n: number }>([
      { $match: { accountId: account._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    AuditLogModel.find({ accountId: account._id })
      .sort({ at: -1, _id: -1 })
      .limit(20)
      .lean<AuditLogDoc[]>(),
  ]);
  const usersByStatus = { invited: 0, active: 0, disabled: 0 };
  for (const s of byStatus) usersByStatus[s._id] = s.n;
  return {
    account: toPublicAccount(account),
    owner: owner ? toPublicUser(owner) : null,
    usersCount: usersByStatus.invited + usersByStatus.active + usersByStatus.disabled,
    usersByStatus,
    recentAudit: recent.map((r) => ({
      id: r._id.toString(),
      action: r.action,
      actor: {
        type: r.actor.type,
        id: r.actor.id ? r.actor.id.toString() : null,
        name: null,
        impersonatorId: r.actor.impersonatorId ? r.actor.impersonatorId.toString() : null,
        platform: r.actor.platform ?? false,
      },
      target: r.target ? { type: r.target.type, id: r.target.id ?? null } : null,
      meta: r.meta ?? null,
      ip: r.ip ?? null,
      at: r.at.toISOString(),
    })),
  };
};

export const suspendAccount = async (req: Request, id: string, reason: string) => {
  const account = await findCustomerAccount(id);
  if (account.status === 'suspended') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The account is already suspended.');
  }
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    { $set: { status: 'suspended', suspendedAt: new Date(), suspendReason: reason } },
    { new: true },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'account.suspended', { reason });
  notifyAccount(updated._id.toString(), 'account.suspended', { reason });
  return toPublicAccount(updated);
};

export const enableAccount = async (req: Request, id: string) => {
  const account = await findCustomerAccount(id);
  if (account.status === 'active') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The account is already active.');
  }
  const updated = await AccountModel.findByIdAndUpdate(
    account._id,
    { $set: { status: 'active', suspendedAt: null, suspendReason: null } },
    { new: true },
  ).lean<AccountDoc>();
  if (!updated) throw new NotFoundError();
  await auditBothSides(req, updated, 'account.enabled');
  notifyAccount(updated._id.toString(), 'account.enabled', {});
  return toPublicAccount(updated);
};

/**
 * Superadmin → 30-minute access token of the account owner with the `imp`
 * claim. No refresh token: when it expires the impersonation ends.
 */
export const impersonate = async (req: Request, id: string): Promise<AuthSession> => {
  const auth = requireAuth(req);
  const account = await findCustomerAccount(id);
  const owner = account.ownerId ? await UserModel.findById(account.ownerId).lean<UserDoc>() : null;
  if (!owner || owner.status !== 'active' || !owner.emailVerifiedAt) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'This account has no active owner to view as.',
    );
  }
  const role = await RoleModel.findOne({
    _id: owner.roleId,
    accountId: account._id,
  }).lean<RoleDoc>();
  if (!role) throw new NotFoundError();
  const { token, expiresAt } = await accessTokenFor(owner, `imp_${randomToken(9)}`, {
    impersonatorId: auth.userId,
    ttl: IMPERSONATION_TTL,
  });
  await auditBothSides(req, account, 'admin.impersonation_started', {
    ownerId: owner._id.toString(),
    expiresAt: expiresAt.toISOString(),
  });
  return {
    accessToken: token,
    expiresIn: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
    ...buildSessionBody(
      { user: owner, role, account },
      { impersonatorId: auth.userId ?? '', expiresAt: expiresAt.toISOString() },
    ),
  };
};

/** Called with the impersonation token itself. */
export const stopImpersonation = async (req: Request): Promise<void> => {
  const auth = requireAuth(req);
  if (!auth.impersonatorId) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Not an impersonation session.');
  }
  const impersonator = await UserModel.findById(auth.impersonatorId).lean<UserDoc>();
  const account = await AccountModel.findById(auth.accountId).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  const actor = { type: 'user' as const, id: auth.impersonatorId, platform: true };
  const entry = {
    actor,
    action: 'admin.impersonation_stopped' as const,
    target: { type: 'account', id: auth.accountId },
    ip: req.ip ?? null,
  };
  await recordAudit({ ...entry, accountId: account._id });
  if (impersonator) await recordAudit({ ...entry, accountId: impersonator.accountId });
};
