import type { Request, RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import { GLOBAL_RATE_LIMIT, STRICT_RATE_LIMIT, UNLIMITED_PATHS } from '../../config/limits';
import { RateLimitedError } from '../errors/app-error';

export interface RateLimiterOptions {
  windowMs: number;
  /** A number, or one per request (e.g. a higher limit for one route). */
  limit: number | ((req: Request) => number);
  /** Defaults to the client IP (honours `trust proxy`). */
  keyGenerator?: (req: Request) => string;
  /** Counter store. MemoryStore by default; the server passes a Redis store (shared across instances). */
  store?: Store;
  skip?: (req: Request) => boolean;
}

/**
 * express-rate-limit with our conventions: `RateLimit-*` (draft-6) headers,
 * `Retry-After`, and a 429 RATE_LIMITED error envelope via the error handler.
 */
export const createRateLimiter = (options: RateLimiterOptions): RequestHandler =>
  rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    ...(options.store ? { store: options.store } : {}),
    skip: options.skip ?? (() => false),
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
  });

/** Every request, per IP; health checks are exempt. */
export const globalRateLimiter = (overrides: Partial<RateLimiterOptions> = {}): RequestHandler =>
  createRateLimiter({
    ...GLOBAL_RATE_LIMIT,
    skip: (req) => UNLIMITED_PATHS.includes(req.path),
    ...overrides,
  });

/** For login / reset / OTP routes (Phase 2) — not mounted globally. */
export const strictRateLimiter = (overrides: Partial<RateLimiterOptions> = {}): RequestHandler =>
  createRateLimiter({ ...STRICT_RATE_LIMIT, ...overrides });

/** Shared counters across API instances (rate-limit-redis, prefix `rl:`). */
export const createRedisRateLimitStore = (
  client: { call: (command: string, ...args: string[]) => Promise<unknown> },
  prefix = 'rl:',
): Store =>
  new RedisStore({
    sendCommand: (command: string, ...args: string[]) =>
      client.call(command, ...args) as Promise<RedisReply>,
    prefix,
  });
