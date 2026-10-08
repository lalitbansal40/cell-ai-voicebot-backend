import cookieParser from 'cookie-parser';
import express, { json, urlencoded, type Express } from 'express';
import type { Store } from 'express-rate-limit';

import type { Env } from './config/env';
import { JSON_BODY_LIMIT, UNLIMITED_PATHS, URLENCODED_BODY_LIMIT } from './config/limits';
import { LocalStorage, type StorageProvider } from './core/storage';
import { createDocsRouter } from './modules/docs/docs.routes';
import { createFilesRouter } from './modules/files/files.routes';
import type { ReadinessDeps } from './modules/health/health.controller';
import { createHealthRouter } from './modules/health/health.routes';
import { createApiRouter } from './routes';
import type { Logger } from './shared/logger';
import { corsMiddleware } from './shared/middlewares/cors';
import { errorHandler } from './shared/middlewares/error-handler';
import { httpLogger } from './shared/middlewares/http-logger';
import { notFound } from './shared/middlewares/not-found';
import { globalRateLimiter, type RateLimiterOptions } from './shared/middlewares/rate-limit';
import { requestId } from './shared/middlewares/request-id';
import { securityHeaders } from './shared/middlewares/security';

export interface AppDeps {
  env: Env;
  logger: Logger;
  /** Test hook: override the global rate limit (e.g. a tiny limit). */
  rateLimit?: Partial<RateLimiterOptions>;
  /** Shared rate-limit counters (Redis) — MemoryStore when omitted. */
  rateLimitStore?: Store;
  /** Readiness checks for GET /ready (server passes Mongo + Redis pings). */
  readiness?: ReadinessDeps;
  /** File storage; the local driver also mounts the signed `/files/*` download route. */
  storage?: StorageProvider;
  /** Auth routes limiter: separate Redis store (`rl:auth:`) + test overrides. */
  authRateLimitStore?: Store;
  authRateLimit?: Partial<RateLimiterOptions>;
}

/**
 * Builds the Express app. Pure: no listening, no I/O — tests use it directly.
 * Pipeline order matters (see src/README.md).
 */
export const createApp = ({
  env,
  logger,
  rateLimit,
  rateLimitStore,
  readiness,
  storage,
  authRateLimitStore,
  authRateLimit,
}: AppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId());
  app.use(httpLogger(logger, { ignorePaths: [...UNLIMITED_PATHS] }));

  app.use(securityHeaders(env));
  app.use(corsMiddleware(env));
  app.use(
    globalRateLimiter({ ...(rateLimitStore ? { store: rateLimitStore } : {}), ...rateLimit }),
  );

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));
  app.use(cookieParser());

  app.use(createHealthRouter(readiness ?? { checks: {}, isShuttingDown: () => false }));
  if (storage instanceof LocalStorage) app.use(createFilesRouter(storage));
  if (env.API_DOCS_ENABLED) app.use(createDocsRouter());
  app.use(
    '/api/v1',
    createApiRouter({
      env,
      auth: { rateLimitStore: authRateLimitStore, rateLimit: authRateLimit },
    }),
  );

  app.use(notFound());
  app.use(errorHandler());
  return app;
};
