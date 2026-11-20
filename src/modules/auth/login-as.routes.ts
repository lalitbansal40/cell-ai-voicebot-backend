import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import { handle } from '../../shared/middlewares/validate';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok as okResponse } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

import { AuthSessionSchema } from './auth.schema';
import { extendFullLoginAs, setRingMeToo, stepUpLoginAs } from './login-as-session';

export const StepUpBody = z.strictObject({
  password: z.string().min(1).max(256).openapi({ format: 'password' }),
  code: z.string().trim().min(6).max(20).optional(),
});
export const RingMeTooBody = z.strictObject({ on: z.boolean() });

const tags = ['Auth'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/login-as/extend',
  tags,
  summary: 'Superadmin full access: 4 more hours (at most 12 hours from the start)',
  security: bearer,
  responses: { 200: okResponse(AuthSessionSchema), 403: errors[403], 409: errors[409] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/login-as/step-up',
  tags,
  summary:
    "Superadmin full access: confirm with the superadmin's own password (+ two-step code) for 5 minutes",
  security: bearer,
  request: json(StepUpBody),
  responses: {
    200: okResponse(z.object({ stepUpUntil: z.string() })),
    403: errors[403],
    422: errors[422],
    429: errors[429],
  },
});
registry.registerPath({
  method: 'put',
  path: '/api/v1/auth/login-as/ring-me-too',
  tags,
  summary: 'Superadmin full access: let incoming calls of this account ring this session too',
  security: bearer,
  request: json(RingMeTooBody),
  responses: { 200: okResponse(z.object({ ringMeToo: z.boolean() })), 403: errors[403] },
});

/** SAC: `/api/v1/auth/login-as/*` — only a superadmin `full` login-as session. */
export const createLoginAsRouter = (): Router => {
  const router = Router();
  router.use(createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30 }), authenticate());
  router.post('/extend', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    ok(res, await extendFullLoginAs(req));
  });
  router.post(
    '/step-up',
    ...handle({ body: StepUpBody }, async ({ body, req, res }) => {
      ok(res, await stepUpLoginAs(req, body));
    }),
  );
  router.put(
    '/ring-me-too',
    ...handle({ body: RingMeTooBody }, async ({ body, req, res }) => {
      ok(res, await setRingMeToo(req, body.on));
    }),
  );
  return router;
};
