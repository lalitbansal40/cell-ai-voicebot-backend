import type { Request } from 'express';

import type { AccountStatus } from '../../db/models/account.model';
import { UnauthenticatedError } from '../errors/app-error';

/** Who is calling (set by `authenticate` or `apiKeyAuth`) — api.md §13: the only source of accountId. */
export interface AuthContext {
  kind: 'user' | 'api_key';
  accountId: string;
  userId?: string;
  apiKeyId?: string;
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
  account: { id: string; status: AccountStatus; timezone: string; isPlatform: boolean };
}

/** The auth context of a request — throws AUTH_UNAUTHENTICATED when the route forgot `authenticate`. */
export const requireAuth = (req: Request): AuthContext => {
  if (!req.auth) throw new UnauthenticatedError();
  return req.auth;
};
