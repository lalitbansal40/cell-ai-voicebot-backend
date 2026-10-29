import type { RequestHandler } from 'express';

import type { Permission, PlatformPermission } from '../../modules/rbac/permissions';
import { requireAuth } from '../auth/auth-context';
import { AppError, ForbiddenError } from '../errors/app-error';

import { rememberRoute } from './access';

/**
 * Allows the request only if the caller has ALL the given permissions (403 AUTH_FORBIDDEN).
 * Dashboard sessions only — API keys reach a route through `access({ scope })`.
 */
export const requirePermission =
  (...perms: (Permission | PlatformPermission)[]): RequestHandler =>
  (req, res, next) => {
    const auth = requireAuth(req);
    if (auth.kind === 'api_key') {
      rememberRoute(req, res);
      throw new ForbiddenError();
    }
    if (!perms.every((p) => auth.permissions.has(p))) throw new ForbiddenError();
    next();
  };

/** Allows the request if the caller has AT LEAST ONE of the permissions (sessions only). */
export const requireAnyPermission =
  (...perms: (Permission | PlatformPermission)[]): RequestHandler =>
  (req, res, next) => {
    const auth = requireAuth(req);
    if (auth.kind === 'api_key') {
      rememberRoute(req, res);
      throw new ForbiddenError();
    }
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
