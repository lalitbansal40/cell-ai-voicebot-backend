import type { RequestHandler } from 'express';
import helmet from 'helmet';

import type { Env } from '../../config/env';

/**
 * Security headers. CSP is off for the JSON API (no HTML is served);
 * the Swagger UI route (T1.14) sets its own CSP. HSTS only in production.
 */
export const securityHeaders = (env: Pick<Env, 'NODE_ENV'>): RequestHandler =>
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity:
      env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
