import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import { blockSensitiveWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok as okResponse } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

import { confirmMfa, disableMfa, mfaStatus, setupMfa, verifyMfa } from './mfa.service';

export const MfaCodeBody = z.strictObject({ code: z.string().trim().min(6).max(20) });
export const MfaDisableBody = z.strictObject({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(20),
});

const tags = ['Auth'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/mfa/status',
  tags,
  summary: 'Whether two-step sign-in is on and enforced (superadmin)',
  security: bearer,
  responses: {
    200: okResponse(z.object({ enabled: z.boolean(), enforced: z.boolean() })),
    403: errors[403],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/mfa/setup',
  tags,
  summary: 'Start two-step sign-in: the secret and otpauth link (superadmin)',
  security: bearer,
  responses: {
    200: okResponse(z.object({ secret: z.string(), otpauthUrl: z.string() })),
    403: errors[403],
    409: errors[409],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/mfa/confirm',
  tags,
  summary: 'Turn it on with a code; returns 10 recovery codes once (superadmin)',
  security: bearer,
  request: json(MfaCodeBody),
  responses: {
    200: okResponse(z.object({ recoveryCodes: z.array(z.string()) })),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/mfa/verify',
  tags,
  summary: 'Check a code or a recovery code before a big action (superadmin)',
  security: bearer,
  request: json(MfaCodeBody),
  responses: {
    200: okResponse(z.object({ verified: z.literal(true) })),
    403: errors[403],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/mfa/disable',
  tags,
  summary: 'Turn it off with the password and a code (superadmin)',
  security: bearer,
  request: json(MfaDisableBody),
  responses: {
    200: okResponse(z.object({ disabled: z.literal(true) })),
    403: errors[403],
    422: errors[422],
  },
});

/** `/api/v1/auth/mfa/*`: the signed-in superadmin's own second step. */
export const createMfaRouter = (): Router => {
  const router = Router();
  const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30 });
  router.use(limiter, authenticate());
  // Phase 19: never the owner's second step from a login-as session
  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    blockSensitiveWhenImpersonating()(req, res, next);
  });
  router.get('/status', async (req, res) => {
    ok(res, await mfaStatus(req));
  });
  router.post('/setup', async (req, res) => {
    ok(res, await setupMfa(req));
  });
  router.post(
    '/confirm',
    ...handle({ body: MfaCodeBody }, async ({ body, req, res }) => {
      ok(res, await confirmMfa(req, body.code));
    }),
  );
  router.post(
    '/verify',
    ...handle({ body: MfaCodeBody }, async ({ body, req, res }) => {
      ok(res, await verifyMfa(req, body.code));
    }),
  );
  router.post(
    '/disable',
    ...handle({ body: MfaDisableBody }, async ({ body, req, res }) => {
      ok(res, await disableMfa(req, body.password, body.code));
    }),
  );
  return router;
};
