import express, { json, urlencoded, type Express } from 'express';

import type { Env } from './config/env';
import { JSON_BODY_LIMIT, UNLIMITED_PATHS, URLENCODED_BODY_LIMIT } from './config/limits';
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
}

/**
 * Builds the Express app. Pure: no listening, no I/O — tests use it directly.
 * Pipeline order matters (see src/README.md).
 */
export const createApp = ({ env, logger, rateLimit }: AppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId());
  app.use(httpLogger(logger, { ignorePaths: [...UNLIMITED_PATHS] }));

  app.use(securityHeaders(env));
  app.use(corsMiddleware(env));
  app.use(globalRateLimiter(rateLimit));

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));

  app.use('/api/v1', createApiRouter());

  app.use(notFound());
  app.use(errorHandler());
  return app;
};
