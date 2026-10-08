import express, { json, urlencoded, type Express } from 'express';

import type { Env } from './config/env';
import { createApiRouter } from './routes';
import type { Logger } from './shared/logger';
import { errorHandler } from './shared/middlewares/error-handler';
import { httpLogger } from './shared/middlewares/http-logger';
import { notFound } from './shared/middlewares/not-found';
import { requestId } from './shared/middlewares/request-id';

export interface AppDeps {
  env: Env;
  logger: Logger;
}

/**
 * Builds the Express app. Pure: no listening, no I/O — tests use it directly.
 * Pipeline order matters (see src/README.md).
 */
export const createApp = ({ logger }: AppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(httpLogger(logger));

  // ── T1.6 security slot: helmet → cors → rate limit ──

  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));

  app.use('/api/v1', createApiRouter());

  app.use(notFound());
  app.use(errorHandler());
  return app;
};
