import type { Request, Response } from 'express';
import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { RoleModel, type RoleDoc } from '../../db/models/role.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { UnauthenticatedError } from '../../shared/errors/app-error';
import { PLATFORM_PERMISSIONS } from '../rbac/permissions';

import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.constants';
import { issueRefresh, refreshTtlMs, type SessionMeta } from './refresh.service';
import { signAccessToken } from './tokens';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: UserDoc['status'];
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  platformRole: 'superadmin' | null;
  createdAt: string;
}

export interface PublicAccount {
  id: string;
  name: string;
  slug: string;
  status: AccountDoc['status'];
  suspendReason: string | null;
  ownerId: string | null;
  isPlatform: boolean;
  timezone: string;
  country: string;
  defaultLanguage: AccountDoc['defaultLanguage'];
  settings: AccountDoc['settings'];
  createdAt: string;
}

export interface Impersonation {
  impersonatorId: string;
  expiresAt: string;
}

export interface AuthSessionBody {
  user: PublicUser;
  account: PublicAccount;
  role: { key: string; name: string };
  permissions: string[];
  impersonation: Impersonation | null;
}

export interface AuthSession extends AuthSessionBody {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toPublicUser = (u: UserDoc): PublicUser => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  phone: u.phone ?? null,
  status: u.status,
  emailVerifiedAt: iso(u.emailVerifiedAt),
  lastLoginAt: iso(u.lastLoginAt),
  platformRole: u.platformRole ?? null,
  createdAt: u.createdAt.toISOString(),
});

export const toPublicAccount = (a: AccountDoc): PublicAccount => ({
  id: a._id.toString(),
  name: a.name,
  slug: a.slug,
  status: a.status,
  suspendReason: a.suspendReason ?? null,
  ownerId: a.ownerId ? a.ownerId.toString() : null,
  isPlatform: a.isPlatform,
  timezone: a.timezone,
  country: a.country,
  defaultLanguage: a.defaultLanguage,
  settings: {
    callingWindow: {
      start: a.settings.callingWindow.start,
      end: a.settings.callingWindow.end,
      days: [...a.settings.callingWindow.days],
    },
    recordingEnabled: a.settings.recordingEnabled,
    aiDisclosureEnabled: a.settings.aiDisclosureEnabled,
  },
  createdAt: a.createdAt.toISOString(),
});

/** User + role + account of a signed-in user. */
export const loadSessionParts = async (
  userId: Types.ObjectId | string,
): Promise<{ user: UserDoc; role: RoleDoc; account: AccountDoc }> => {
  const user = await UserModel.findById(userId).lean<UserDoc>();
  if (!user) throw new UnauthenticatedError();
  const [role, account] = await Promise.all([
    RoleModel.findOne({ _id: user.roleId, accountId: user.accountId }).lean<RoleDoc>(),
    AccountModel.findById(user.accountId).lean<AccountDoc>(),
  ]);
  if (!role || !account) throw new UnauthenticatedError();
  return { user, role, account };
};

export const buildSessionBody = (
  parts: { user: UserDoc; role: RoleDoc; account: AccountDoc },
  impersonation: Impersonation | null = null,
): AuthSessionBody => {
  const permissions = new Set(parts.role.permissions);
  if (parts.user.platformRole === 'superadmin' && !impersonation) {
    for (const p of PLATFORM_PERMISSIONS) permissions.add(p);
  }
  return {
    user: toPublicUser(parts.user),
    account: toPublicAccount(parts.account),
    role: { key: parts.role.key, name: parts.role.name },
    permissions: [...permissions].sort(),
    impersonation,
  };
};

/** Access token for a session id (refresh family). */
export const accessTokenFor = async (
  user: Pick<UserDoc, '_id' | 'accountId' | 'roleId' | 'tokenVersion'>,
  sessionId: string,
  options: { impersonatorId?: string; ttl?: string } = {},
) =>
  signAccessToken(
    {
      sub: user._id.toString(),
      acc: user.accountId.toString(),
      rid: user.roleId.toString(),
      tv: user.tokenVersion,
      sid: sessionId,
      ...(options.impersonatorId ? { imp: options.impersonatorId } : {}),
    },
    options.ttl ?? getEnv().JWT_ACCESS_TTL,
  );

const cookieOptions = () => {
  const env = getEnv();
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  };
};

export const setRefreshCookie = (res: Response, raw: string): void => {
  res.cookie(REFRESH_COOKIE, raw, { ...cookieOptions(), maxAge: refreshTtlMs() });
};

export const clearRefreshCookie = (res: Response): void => {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
};

export const requestMeta = (req: Request): SessionMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/** Session payload + access token for an existing refresh family. */
export const sessionFor = async (
  parts: { user: UserDoc; role: RoleDoc; account: AccountDoc },
  sessionId: string,
): Promise<AuthSession> => {
  const { token, expiresAt } = await accessTokenFor(parts.user, sessionId);
  return {
    accessToken: token,
    expiresIn: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
    ...buildSessionBody(parts),
  };
};

/** New login session: refresh family + cookie + access token. */
export const startSession = async (
  req: Request,
  res: Response,
  userId: Types.ObjectId,
): Promise<AuthSession> => {
  const parts = await loadSessionParts(userId);
  const { raw, doc } = await issueRefresh({
    userId: parts.user._id,
    accountId: parts.user.accountId,
    meta: requestMeta(req),
  });
  setRefreshCookie(res, raw);
  return sessionFor(parts, doc.familyId);
};
