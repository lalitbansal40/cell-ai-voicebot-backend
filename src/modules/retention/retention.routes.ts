import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { RetentionBody } from './retention.schema';
import { getRetention, updateRetention } from './retention.service';

/** `/api/v1/account/retention` (Phase 14). */
export const createRetentionRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get('/retention', requirePermission('account.read'), async (req, res) => {
    ok(res, await getRetention(req));
  });
  router.put(
    '/retention',
    requirePermission('account.update'),
    ...handle({ body: RetentionBody }, async ({ body, req, res }) => {
      ok(res, await updateRetention(req, body));
    }),
  );
  return router;
};
