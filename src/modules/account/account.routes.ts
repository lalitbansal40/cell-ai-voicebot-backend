import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { UpdateAccountBody } from './account.schema';
import { getAccount, updateAccount } from './account.service';

/** `/api/v1/account` — the caller's own account (no id in the path, api.md §13). */
export const createAccountRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get('/', requirePermission('account.read'), async (req, res) => {
    ok(res, await getAccount(req));
  });
  router.patch(
    '/',
    requirePermission('account.update'),
    ...handle({ body: UpdateAccountBody }, async ({ body, req, res }) => {
      ok(res, await updateAccount(req, body));
    }),
  );
  return router;
};
