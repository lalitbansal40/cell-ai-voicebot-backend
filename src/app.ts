import cookieParser from 'cookie-parser';
import express, { json, raw, urlencoded, type Express } from 'express';
import type { Store } from 'express-rate-limit';

import type { Env } from './config/env';
import {
  BILLING_LIMITS,
  JSON_BODY_LIMIT,
  UNLIMITED_PATHS,
  URLENCODED_BODY_LIMIT,
} from './config/limits';
import { registerWalletAlerts } from './core/billing/alerts';
import type { BillingJobs } from './core/billing/jobs';
import { createPaymentProvider, type PaymentProvider } from './core/payments';
import { LocalStorage, type StorageProvider } from './core/storage';
import type { ContactJobs } from './modules/contacts/jobs';
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
  /** Enqueues background contact jobs (imports, exports, bulk) — Phase 3. */
  contactJobs?: ContactJobs;
  /** Payment gateway — built from env (`PAYMENT_PROVIDER`) when omitted. */
  payments?: PaymentProvider;
  /** Enqueues billing jobs (invoice render) — Phase 4. */
  billingJobs?: BillingJobs;
  /** Top-up orders limiter store (`rl:topup:`); MemoryStore when omitted. */
  topupRateLimitStore?: Store;
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
  contactJobs,
  payments = createPaymentProvider(env),
  billingJobs,
  topupRateLimitStore,
}: AppDeps): Express => {
  // Wallet low-balance / exhausted alerts run after every committed wallet change.
  registerWalletAlerts();
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

  // Payment webhooks need the exact bytes for the signature: raw body, this path only.
  app.use(
    '/api/v1/webhooks/razorpay',
    raw({ type: 'application/json', limit: BILLING_LIMITS.webhookMaxBytes }),
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
      contacts: { storage, jobs: contactJobs },
      billing: { storage, payments, jobs: billingJobs, topupRateLimitStore },
    }),
  );

  app.use(notFound());
  app.use(errorHandler());
  return app;
};
