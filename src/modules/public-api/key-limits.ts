import type { Request, RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';

import { PUBLIC_API_LIMITS } from '../../config/limits';
import {
  isApiKeyRequest,
  READ_METHODS,
  resolveApiKey,
} from '../../shared/middlewares/api-key-auth';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';

import { recordKeyRequest } from './request-log';

const KEY_ID_LOCAL = 'apiKeyId';
const keyIdOf = (req: Request): string => String(req.res?.locals[KEY_ID_LOCAL] ?? '');

export interface PublicApiStores {
  /** Redis stores in the server (`rl:key:<id>:r` / `:w`); memory in tests. */
  read?: Store;
  write?: Store;
}

/**
 * Mounted on `/api/v1` before the routers: for `X-API-Key` requests (no session)
 * it verifies the key, logs the request (after the response) and applies the
 * per-key limits — 600 reads and 60 writes a minute (`RateLimit-*`, 429
 * RATE_LIMITED + `Retry-After`). Dashboard sessions keep the global limiter only.
 */
export const publicApiGate = (stores: PublicApiStores = {}): RequestHandler => {
  const reads = createRateLimiter({
    windowMs: 60_000,
    limit: PUBLIC_API_LIMITS.readsPerMinute,
    keyGenerator: (req) => `key:${keyIdOf(req)}:r`,
    ...(stores.read ? { store: stores.read } : {}),
  });
  const writes = createRateLimiter({
    windowMs: 60_000,
    limit: PUBLIC_API_LIMITS.writesPerMinute,
    keyGenerator: (req) => `key:${keyIdOf(req)}:w`,
    ...(stores.write ? { store: stores.write } : {}),
  });
  return async (req, res, next) => {
    if (!isApiKeyRequest(req)) {
      next();
      return;
    }
    const key = await resolveApiKey(req);
    recordKeyRequest(req, res, key);
    res.locals[KEY_ID_LOCAL] = key.id;
    const limiter = READ_METHODS.has(req.method) ? reads : writes;
    limiter(req, res, next);
  };
};
