import type { RequestHandler } from 'express';

import { AccountModel } from '../../db/models/account.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';
import { verifyAccessToken } from '../../modules/auth/tokens';
import { PLATFORM_PERMISSIONS } from '../../modules/rbac/permissions';
import { AppError, UnauthenticatedError } from '../errors/app-error';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Authorization: Bearer <token>` → the token, else undefined. */
export const bearerToken = (header: string | undefined): string | undefined => {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
  return match?.[1];
};

/**
 * Dashboard auth (ADR 0009): verifies the access JWT, then loads the user,
 * role and account on every request so disabling a user, changing a role or
 * suspending an account takes effect immediately. Sets `req.auth`.
 */
export const authenticate = (): RequestHandler => async (req, _res, next) => {
  const token = bearerToken(req.get('authorization'));
  if (!token) throw new UnauthenticatedError();
  const claims = await verifyAccessToken(token);

  const user = await UserModel.findById(claims.sub)
    .select({
      accountId: 1,
      roleId: 1,
      status: 1,
      emailVerifiedAt: 1,
      tokenVersion: 1,
      platformRole: 1,
    })
    .lean();
  if (!user || user.accountId.toString() !== claims.acc) throw new UnauthenticatedError();
  if (user.tokenVersion !== claims.tv) throw new UnauthenticatedError();
  if (user.status === 'disabled') throw new AppError('AUTH_USER_DISABLED');
  if (user.status !== 'active') throw new UnauthenticatedError();
  if (!user.emailVerifiedAt) throw new AppError('AUTH_EMAIL_NOT_VERIFIED');

  const [role, account] = await Promise.all([
    RoleModel.findOne({ _id: user.roleId, accountId: user.accountId })
      .select({ key: 1, permissions: 1 })
      .lean(),
    AccountModel.findById(user.accountId).select({ status: 1, timezone: 1, isPlatform: 1 }).lean(),
  ]);
  if (!role || !account) throw new UnauthenticatedError();

  const superadmin = user.platformRole === 'superadmin' && !claims.imp;
  if (account.status === 'suspended' && !superadmin && !READ_METHODS.has(req.method)) {
    throw new AppError('AUTH_ACCOUNT_SUSPENDED');
  }

  const permissions = new Set<string>(role.permissions);
  if (superadmin) for (const p of PLATFORM_PERMISSIONS) permissions.add(p);

  req.auth = {
    kind: 'user',
    accountId: claims.acc,
    userId: claims.sub,
    roleId: role._id.toString(),
    roleKey: role.key,
    permissions,
    ...(superadmin ? { platformRole: 'superadmin' as const } : {}),
    ...(claims.imp ? { impersonatorId: claims.imp } : {}),
    sessionId: claims.sid,
    tokenVersion: user.tokenVersion,
    account: {
      id: account._id.toString(),
      status: account.status,
      timezone: account.timezone,
      isPlatform: account.isPlatform,
    },
  };
  req.log = req.log.child({ accountId: claims.acc, userId: claims.sub });
  next();
};
