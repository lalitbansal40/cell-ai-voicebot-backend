import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { AUTH_RATE_LIMIT } from '../../config/limits';
import { createRateLimiter, type RateLimiterOptions } from '../../shared/middlewares/rate-limit';
import { handle } from '../../shared/middlewares/validate';

import { resendHandler, signupHandler, verifyEmailHandler } from './auth.controller';
import { EmailOnlyBody, SignupBody, VerifyEmailBody } from './auth.schema';

export interface AuthRouterDeps {
  /** Separate store (prefix `rl:auth:`) — never share the global limiter's store. */
  rateLimitStore?: Store;
  /** Test hook. */
  rateLimit?: Partial<RateLimiterOptions>;
}

/** `/api/v1/auth/*` — public auth endpoints share one per-IP-and-route limiter. */
export const createAuthRouter = (deps: AuthRouterDeps = {}): Router => {
  const router = Router();
  const limiter = createRateLimiter({
    ...AUTH_RATE_LIMIT,
    keyGenerator: (req) => `${req.ip ?? 'unknown'}:${req.path}`,
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
    ...deps.rateLimit,
  });

  router.post('/signup', limiter, ...handle({ body: SignupBody }, signupHandler));
  router.post('/verify-email', limiter, ...handle({ body: VerifyEmailBody }, verifyEmailHandler));
  router.post('/verify-email/resend', limiter, ...handle({ body: EmailOnlyBody }, resendHandler));
  return router;
};
