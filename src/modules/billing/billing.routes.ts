import { Router } from 'express';

import { GST_STATES } from '../../shared/gst-states';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { BillingProfileBody } from './billing.schema';
import { getBillingProfile, saveBillingProfile } from './profile.service';

/** `/api/v1/billing` — billing details for invoices, GST states. */
export const createBillingRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get('/states', (_req, res) => {
    ok(
      res,
      GST_STATES.map((s) => ({ code: s.code, name: s.name })),
    );
  });
  router.get(
    '/profile',
    requirePermission('wallet.read'),
    ...handle({}, async ({ req, res }) => {
      ok(res, await getBillingProfile(req));
    }),
  );
  router.put(
    '/profile',
    requirePermission('wallet.topup'),
    blockWhenImpersonating(),
    ...handle({ body: BillingProfileBody }, async ({ body, req, res }) => {
      ok(res, await saveBillingProfile(req, body));
    }),
  );
  return router;
};
