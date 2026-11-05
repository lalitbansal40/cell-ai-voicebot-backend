import { Router } from 'express';
import { ipKeyGenerator, type Store } from 'express-rate-limit';

import type { Env } from '../../config/env';
import { AUTH_RATE_LIMIT, AUTH_REFRESH_RATE_LIMIT, SIGNUP_RATE_LIMIT } from '../../config/limits';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { originCheck } from '../../shared/middlewares/origin-check';
import { createRateLimiter, type RateLimiterOptions } from '../../shared/middlewares/rate-limit';
import { blockSensitiveWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { getSignupSettings } from '../account/kinds';
import { AcceptInviteBody, InviteTokenQuery } from '../team/team.schema';
import { acceptInvite, inviteInfo } from '../team/team.service';

import {
  changePasswordHandler,
  forgotPasswordHandler,
  loginHandler,
  logoutAllHandler,
  logoutHandler,
  meHandler,
  goneHandler,
  refreshHandler,
  resetPasswordHandler,
  revokeSessionHandler,
  sessionsHandler,
  signupHandler,
} from './auth.controller';
import {
  ChangePasswordBody,
  EmailOnlyBody,
  LoginBody,
  ResetPasswordBody,
  SessionIdParams,
  SignupBody,
  UpdateProfileBody,
} from './auth.schema';
import { updateProfile } from './login.service';

export interface AuthRouterDeps {
  env: Pick<Env, 'CORS_ORIGINS' | 'NODE_ENV'> & Partial<Pick<Env, 'AUTH_RATE_LIMIT_MAX'>>;
  /** Separate store (prefix `rl:auth:`) — never share the global limiter's store. */
  rateLimitStore?: Store;
  /** Signup uses a different hour-long Redis window/prefix. */
  signupRateLimitStore?: Store;
  /** Test hook. */
  rateLimit?: Partial<RateLimiterOptions>;
}

/** `/api/v1/auth/*` — public auth endpoints share one per-IP-and-route limiter. */
export const createAuthRouter = (deps: AuthRouterDeps): Router => {
  const router = Router();
  const limiter = createRateLimiter({
    ...AUTH_RATE_LIMIT,
    limit: (req) =>
      req.path === '/refresh'
        ? AUTH_REFRESH_RATE_LIMIT
        : (deps.env.AUTH_RATE_LIMIT_MAX ?? AUTH_RATE_LIMIT.limit),
    // ipKeyGenerator groups IPv6 addresses by /56 so a client can't rotate addresses.
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${req.path}`,
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
    ...deps.rateLimit,
  });

  // Phase 19: open signup (no e-mail) — 5 an hour per IP on top of the auth limiter
  const signupLimiter = createRateLimiter({
    windowMs: SIGNUP_RATE_LIMIT.windowMs,
    limit: SIGNUP_RATE_LIMIT.limit,
    keyGenerator: (req) => `signup-ip:${ipKeyGenerator(req.ip ?? '')}`,
    ...(deps.signupRateLimitStore ? { store: deps.signupRateLimitStore } : {}),
    // tests that lift the auth limit lift this one too
    ...(deps.rateLimit?.limit !== undefined ? { limit: deps.rateLimit.limit } : {}),
  });
  router.get('/signup-options', limiter, async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    ok(res, await getSignupSettings());
  });
  router.post('/signup', limiter, signupLimiter, ...handle({ body: SignupBody }, signupHandler));
  router.post('/verify-email', limiter, goneHandler);
  router.post('/verify-email/resend', limiter, goneHandler);
  router.post('/login', limiter, ...handle({ body: LoginBody }, loginHandler));
  router.post('/refresh', limiter, originCheck(deps.env), refreshHandler);
  router.post('/logout', originCheck(deps.env), logoutHandler);
  router.get(
    '/invite-info',
    limiter,
    ...handle({ query: InviteTokenQuery }, async ({ query, res }) => {
      ok(res, await inviteInfo(query.token));
    }),
  );
  router.post(
    '/accept-invite',
    limiter,
    ...handle({ body: AcceptInviteBody }, async ({ body, req, res }) => {
      ok(res, await acceptInvite(req, res, body));
    }),
  );
  router.post(
    '/forgot-password',
    limiter,
    ...handle({ body: EmailOnlyBody }, forgotPasswordHandler),
  );
  router.post(
    '/reset-password',
    limiter,
    ...handle({ body: ResetPasswordBody }, resetPasswordHandler),
  );
  router.post(
    '/change-password',
    authenticate(),
    blockSensitiveWhenImpersonating(),
    ...handle({ body: ChangePasswordBody }, changePasswordHandler),
  );
  router.post('/logout-all', authenticate(), blockSensitiveWhenImpersonating(), logoutAllHandler);
  router.get('/me', authenticate(), meHandler);
  router.patch(
    '/me',
    authenticate(),
    ...handle({ body: UpdateProfileBody }, async ({ body, req, res }) => {
      ok(res, await updateProfile(req, body));
    }),
  );
  router.get('/sessions', authenticate(), sessionsHandler);
  router.delete(
    '/sessions/:id',
    authenticate(),
    blockSensitiveWhenImpersonating(),
    ...handle({ params: SessionIdParams }, revokeSessionHandler),
  );
  return router;
};
