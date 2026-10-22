import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';

import type { WhatsAppContext } from './context';
import { deletionStatus, handleDataDeletion, handleDeauthorize } from './meta-callbacks.service';

/**
 * `/api/v1/meta` — Meta app callbacks (App Review prerequisites, §1i). Public;
 * POSTs are form bodies trusted only through `signed_request`. Mounted only when
 * `WHATSAPP_ENABLED`.
 */
export const createMetaCallbacksRouter = ({ ctx }: { ctx: WhatsAppContext }): Router => {
  const router = Router();
  router.post('/deauthorize', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    ok(res, await handleDeauthorize(ctx, body.signed_request));
  });
  router.post('/data-deletion', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Meta reads exactly `{ url, confirmation_code }` (no envelope)
    res.json(await handleDataDeletion(ctx, body.signed_request));
  });
  router.get(
    '/data-deletion/:code',
    createRateLimiter({ windowMs: 60_000, limit: 30 }),
    async (req, res) => {
      ok(res, await deletionStatus(String(req.params.code)));
    },
  );
  return router;
};
