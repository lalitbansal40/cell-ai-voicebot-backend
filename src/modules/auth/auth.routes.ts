import { Router } from 'express';
import { ipKeyGenerator, type Store } from 'express-rate-limit';

import type { Env } from '../../config/env';
import { AUTH_RATE_LIMIT } from '../../config/limits';
import { authenticate } from '../../shared/middlewares/authenticate';
import { originCheck } from '../../shared/middlewares/origin-check';
import { createRateLimiter, type RateLimiterOptions } from '../../shared/middlewares/rate-limit';
import { blockWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  loginHandler,
  logoutAllHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  resendHandler,
  revokeSessionHandler,
  sessionsHandler,
  signupHandler,
  verifyEmailHandler,
} from './auth.controller';
import {
  EmailOnlyBody,
  LoginBody,
  SessionIdParams,
  SignupBody,
  VerifyEmailBody,
} from './auth.schema';

export interface AuthRouterDeps {
  env: Pick<Env, 'CORS_ORIGINS' | 'NODE_ENV'>;
  /** Separate store (prefix `rl:auth:`) — never share the global limiter's store. */
  rateLimitStore?: Store;
  /** Test hook. */
  rateLimit?: Partial<RateLimiterOptions>;
}

/** `/api/v1/auth/*` — public auth endpoints share one per-IP-and-route limiter. */
export const createAuthRouter = (deps: AuthRouterDeps): Router => {
  const router = Router();
  const limiter = createRateLimiter({
    ...AUTH_RATE_LIMIT,
    // ipKeyGenerator groups IPv6 addresses by /56 so a client can't rotate addresses.
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${req.path}`,
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
    ...deps.rateLimit,
  });

  router.post('/signup', limiter, ...handle({ body: SignupBody }, signupHandler));
  router.post('/verify-email', limiter, ...handle({ body: VerifyEmailBody }, verifyEmailHandler));
  router.post('/verify-email/resend', limiter, ...handle({ body: EmailOnlyBody }, resendHandler));
  router.post('/login', limiter, ...handle({ body: LoginBody }, loginHandler));
  router.post('/refresh', limiter, originCheck(deps.env), refreshHandler);
  router.post('/logout', originCheck(deps.env), logoutHandler);
  router.post('/logout-all', authenticate(), blockWhenImpersonating(), logoutAllHandler);
  router.get('/me', authenticate(), meHandler);
  router.get('/sessions', authenticate(), sessionsHandler);
  router.delete(
    '/sessions/:id',
    authenticate(),
    ...handle({ params: SessionIdParams }, revokeSessionHandler),
  );
  return router;
};
