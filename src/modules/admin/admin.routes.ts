import { Router } from 'express';

import { noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePlatformAdmin } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { AccountIdParams, ListAccountsQuery, SuspendBody } from './admin.schema';
import {
  accountDetail,
  enableAccount,
  impersonate,
  listAccounts,
  stopImpersonation,
  suspendAccount,
} from './admin.service';

/** `/api/v1/admin` — platform superadmin only. */
export const createAdminRouter = (): Router => {
  const router = Router();
  router.use(authenticate());

  // Uses the impersonation token, so it is NOT behind requirePlatformAdmin.
  router.post('/impersonation/stop', async (req, res) => {
    await stopImpersonation(req);
    noContent(res);
  });

  router.use(requirePlatformAdmin());
  router.get(
    '/accounts',
    ...handle({ query: ListAccountsQuery }, async ({ query, res }) => {
      const { items, meta } = await listAccounts(query);
      ok(res, items, meta);
    }),
  );
  router.get(
    '/accounts/:id',
    ...handle({ params: AccountIdParams }, async ({ params, res }) => {
      ok(res, await accountDetail(params.id));
    }),
  );
  router.post(
    '/accounts/:id/suspend',
    ...handle(
      { params: AccountIdParams, body: SuspendBody },
      async ({ params, body, req, res }) => {
        ok(res, await suspendAccount(req, params.id, body.reason));
      },
    ),
  );
  router.post(
    '/accounts/:id/enable',
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      ok(res, await enableAccount(req, params.id));
    }),
  );
  router.post(
    '/accounts/:id/impersonate',
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      res.set('Cache-Control', 'no-store');
      ok(res, await impersonate(req, params.id));
    }),
  );
  return router;
};
