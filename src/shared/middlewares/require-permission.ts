import type { RequestHandler } from 'express';

import type { Permission, PlatformPermission } from '../../modules/rbac/permissions';
import { requireAuth } from '../auth/auth-context';
import { AppError, ForbiddenError } from '../errors/app-error';

/** Allows the request only if the caller has ALL the given permissions (403 AUTH_FORBIDDEN). */
export const requirePermission =
  (...perms: (Permission | PlatformPermission)[]): RequestHandler =>
  (req, _res, next) => {
    const auth = requireAuth(req);
    if (!perms.every((p) => auth.permissions.has(p))) throw new ForbiddenError();
    next();
  };

/** Allows the request if the caller has AT LEAST ONE of the permissions. */
export const requireAnyPermission =
  (...perms: (Permission | PlatformPermission)[]): RequestHandler =>
  (req, _res, next) => {
    const auth = requireAuth(req);
    if (!perms.some((p) => auth.permissions.has(p))) throw new ForbiddenError();
    next();
  };

/** Platform superadmin only — never while impersonating. */
export const requirePlatformAdmin = (): RequestHandler => (req, _res, next) => {
  const auth = requireAuth(req);
  if (auth.platformRole !== 'superadmin' || auth.impersonatorId) throw new ForbiddenError();
  next();
};

/** Sensitive actions a superadmin may not do while viewing as a user. */
export const blockWhenImpersonating = (): RequestHandler => (req, _res, next) => {
  if (req.auth?.impersonatorId) throw new AppError('AUTH_IMPERSONATION_BLOCKED');
  next();
};
