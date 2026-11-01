import type { Request, RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';

import { PUBLIC_API_LIMITS } from '../../config/limits';
import { AccountModel } from '../../db/models/account.model';
import {
  isApiKeyRequest,
  READ_METHODS,
  resolveApiKey,
} from '../../shared/middlewares/api-key-auth';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';

import { recordKeyRequest } from './request-log';

const KEY_ID_LOCAL = 'apiKeyId';
const keyIdOf = (req: Request): string => String(req.res?.locals[KEY_ID_LOCAL] ?? '');

const ACCOUNT_LOCAL = 'apiKeyAccountId';
type ApiLimits = { readsPerMinute: number; writesPerMinute: number } | null;
const limitsCache = new Map<string, { value: ApiLimits; until: number }>();

/** A superadmin's limits for this account; a change is picked up within 30 seconds. */
const accountLimits = async (req: Request): Promise<ApiLimits> => {
  const accountId = String(req.res?.locals[ACCOUNT_LOCAL] ?? '');
  const cached = limitsCache.get(accountId);
  if (cached && cached.until > Date.now()) return cached.value;
  const account = await AccountModel.findById(accountId)
    .select({ apiLimits: 1 })
    .lean<{ apiLimits?: ApiLimits }>();
  const value = account?.apiLimits ?? null;
  limitsCache.set(accountId, {
    value,
    until: Date.now() + PUBLIC_API_LIMITS.keyCacheSec * 1000,
  });
  return value;
};

/** Tests start from a clean cache. */
export const clearApiLimitsCache = (): void => {
  limitsCache.clear();
};

export interface PublicApiStores {
  /** Redis stores in the server (`rl:key:<id>:r` / `:w`); memory in tests. */
  read?: Store;
  write?: Store;
}

/**
 * Mounted on `/api/v1` before the routers: for `X-API-Key` requests (no session)
 * it verifies the key, logs the request (after the response) and applies the
 * per-key limits — 600 reads and 60 writes a minute unless a superadmin set others (`RateLimit-*`, 429
 * RATE_LIMITED + `Retry-After`). Dashboard sessions keep the global limiter only.
 */
export const publicApiGate = (stores: PublicApiStores = {}): RequestHandler => {
  const reads = createRateLimiter({
    windowMs: 60_000,
    limit: async (req) =>
      (await accountLimits(req))?.readsPerMinute ?? PUBLIC_API_LIMITS.readsPerMinute,
    keyGenerator: (req) => `key:${keyIdOf(req)}:r`,
    ...(stores.read ? { store: stores.read } : {}),
  });
  const writes = createRateLimiter({
    windowMs: 60_000,
    limit: async (req) =>
      (await accountLimits(req))?.writesPerMinute ?? PUBLIC_API_LIMITS.writesPerMinute,
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
    res.locals[ACCOUNT_LOCAL] = key.accountId;
    const limiter = READ_METHODS.has(req.method) ? reads : writes;
    limiter(req, res, next);
  };
};
