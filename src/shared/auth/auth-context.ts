import type { Request } from 'express';

import type { AccountStatus } from '../../db/models/account.model';
import { UnauthenticatedError } from '../errors/app-error';

/** Who is calling (set by `authenticate` or `apiKeyAuth`) — api.md §13: the only source of accountId. */
export interface AuthContext {
  kind: 'user' | 'api_key';
  accountId: string;
  userId?: string;
  apiKeyId?: string;
  /** API keys: the user who created the key (owner of what the key creates, e.g. exports). */
  keyOwnerId?: string;
  roleId?: string;
  roleKey?: string;
  permissions: ReadonlySet<string>;
  scopes?: ReadonlySet<string>;
  platformRole?: 'superadmin';
  /** Superadmin acting as this user (impersonation token). */
  impersonatorId?: string;
  /** Refresh family of the session (`imp_…` while impersonating). */
  sessionId?: string;
  tokenVersion?: number;
  /** Access token expiry (user tokens). */
  tokenExpiresAt?: Date;
  account: { id: string; status: AccountStatus; timezone: string; isPlatform: boolean };
}

/** The auth context of a request — throws AUTH_UNAUTHENTICATED when the route forgot `authenticate`. */
export const requireAuth = (req: Request): AuthContext => {
  if (!req.auth) throw new UnauthenticatedError();
  return req.auth;
};

/** The user a request acts for: the signed-in user, or the creator of the API key. */
export const actingUserId = (auth: AuthContext): string => {
  const id = auth.userId ?? auth.keyOwnerId;
  if (!id) throw new UnauthenticatedError();
  return id;
};
