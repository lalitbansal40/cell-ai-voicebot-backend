import type { RequestHandler } from 'express';

import type { Env } from '../../config/env';
import { ForbiddenError } from '../errors/app-error';

/**
 * CSRF guard for cookie-authenticated endpoints (refresh / logout): a
 * present `Origin` must be in CORS_ORIGINS. A missing Origin is allowed only
 * outside production (curl, tests) — browsers always send it on POST.
 */
export const originCheck =
  (env: Pick<Env, 'CORS_ORIGINS' | 'NODE_ENV'>): RequestHandler =>
  (req, _res, next) => {
    const origin = req.get('origin');
    if (origin === undefined) {
      if (env.NODE_ENV === 'production') throw new ForbiddenError();
      next();
      return;
    }
    if (!env.CORS_ORIGINS.includes(origin.replace(/\/+$/, ''))) throw new ForbiddenError();
    next();
  };
