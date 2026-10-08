import type { RequestHandler } from 'express';
import helmet, { contentSecurityPolicy } from 'helmet';

import type { Env } from '../../config/env';

/**
 * Security headers. CSP is off for the JSON API (no HTML is served); the
 * Swagger UI router (`/api/docs`) adds `docsCsp()`. HSTS only in production.
 */
export const securityHeaders = (env: Pick<Env, 'NODE_ENV'>): RequestHandler =>
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity:
      env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

/**
 * Strict CSP for the Swagger UI pages: scripts only from this origin (no
 * inline scripts); inline styles are needed by Swagger UI itself.
 */
export const docsCsp = (): RequestHandler =>
  contentSecurityPolicy({
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  });
