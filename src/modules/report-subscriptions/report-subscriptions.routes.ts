import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CreateSubscriptionBody,
  SubscriptionParams,
  UnsubscribeBody,
  UnsubscribeQuery,
  UpdateSubscriptionBody,
} from './report-subscriptions.schema';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  unsubscribe,
  updateSubscription,
} from './report-subscriptions.service';

/** `/api/v1/report-subscriptions` — each person's own report e-mails (Phase 14). */
export const createReportSubscriptionsRouter = (): Router => {
  const router = Router();
  router.use(authenticate(), requirePermission('reports.read'));
  router.get('/', async (req, res) => {
    ok(res, await listSubscriptions(req));
  });
  router.post(
    '/',
    blockWhenImpersonating(),
    ...handle({ body: CreateSubscriptionBody }, async ({ body, req, res }) => {
      created(res, await createSubscription(req, body));
    }),
  );
  router.patch(
    '/:id',
    blockWhenImpersonating(),
    ...handle(
      { params: SubscriptionParams, body: UpdateSubscriptionBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateSubscription(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    blockWhenImpersonating(),
    ...handle({ params: SubscriptionParams }, async ({ params, req, res }) => {
      await deleteSubscription(req, params.id);
      noContent(res);
    }),
  );
  return router;
};

/** `/api/v1/report-unsubscribe` — the e-mail's one-click stop (no login). */
export const createReportUnsubscribeRouter = (): Router => {
  const router = Router();
  router.post(
    '/',
    createRateLimiter({
      windowMs: 60_000,
      limit: 20,
      keyGenerator: (req) => `report-unsub:${ipKeyGenerator(req.ip ?? '')}`,
    }),
    ...handle({ body: UnsubscribeBody, query: UnsubscribeQuery }, async ({ body, query, res }) => {
      await unsubscribe(body.token ?? query.token ?? '');
      ok(res, { stopped: true as const });
    }),
  );
  return router;
};
