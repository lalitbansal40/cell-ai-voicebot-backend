import type { Request, RequestHandler, Response } from 'express';

import type { ApiKeyScope } from '../../modules/api-keys/scopes';
import type { Permission } from '../../modules/rbac/permissions';
import { requireAuth } from '../auth/auth-context';
import { AppError, ForbiddenError } from '../errors/app-error';

/** The matched route as a template (`/api/v1/calls/:id`) — the request log never stores ids. */
export const routeTemplate = (req: Request): string => {
  const route = req.route as { path?: unknown } | undefined;
  return `${req.baseUrl}${typeof route?.path === 'string' ? route.path : ''}`;
};

/** Remembered on the response for the request log (set once the route matched). */
export const ROUTE_TEMPLATE_LOCAL = 'routeTemplate';

export const rememberRoute = (req: Request, res: Response): void => {
  res.locals[ROUTE_TEMPLATE_LOCAL] = routeTemplate(req);
};

/**
 * One route, two auths (ADR 0045): a dashboard session needs `permission`, an
 * API key needs `scope` (403 AUTH_FORBIDDEN with `details: [{ path: 'scope' }]`).
 * `permission` may be a list — the session needs at least one. The router must
 * run `authenticate({ apiKeys: true })` first. Without `scope` the route stays
 * session-only.
 */
export const access =
  ({
    permission,
    scope,
  }: {
    permission: Permission | Permission[];
    scope?: ApiKeyScope;
  }): RequestHandler =>
  (req, res, next) => {
    const auth = requireAuth(req);
    if (auth.kind === 'api_key') {
      rememberRoute(req, res);
      if (!scope) throw new ForbiddenError();
      if (!auth.scopes?.has(scope)) {
        throw new AppError('AUTH_FORBIDDEN', undefined, [
          { path: 'scope', message: `${scope} is required` },
        ]);
      }
      next();
      return;
    }
    const needed = Array.isArray(permission) ? permission : [permission];
    if (!needed.some((p) => auth.permissions.has(p))) throw new ForbiddenError();
    next();
  };
