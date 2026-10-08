import cors from 'cors';
import type { RequestHandler } from 'express';

import type { Env } from '../../config/env';

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Request-Id',
  'Idempotency-Key',
  'X-API-Key',
];
export const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
];

/**
 * Exact-match origin allowlist from CORS_ORIGINS. Requests without an Origin
 * (server-to-server, curl, webhooks) pass; unknown origins get no CORS headers,
 * so browsers block them — the request itself is not rejected server-side.
 */
export const corsMiddleware = (env: Pick<Env, 'CORS_ORIGINS'>): RequestHandler => {
  const allowed = new Set(env.CORS_ORIGINS);
  return cors({
    origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
};
