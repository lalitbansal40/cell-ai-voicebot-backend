import { Router } from 'express';

import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { created, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  requirePermission,
  requirePlatformAdmin,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AssignPhoneNumberBody,
  CreatePhoneNumberBody,
  ListPhoneNumbersQuery,
  PhoneNumberIdParams,
  UpdatePhoneNumberBody,
} from './phone-numbers.schema';
import {
  accountPhoneLine,
  accountPhoneNumbers,
  assignPhoneNumber,
  createPhoneNumber,
  listPhoneNumbers,
  releasePhoneNumber,
  updatePhoneNumber,
} from './phone-numbers.service';

/** `/api/v1/admin/phone-numbers` — the trunk's caller IDs (superadmin, Phase 18). */
export const createAdminPhoneNumbersRouter = (): Router => {
  const router = Router();
  const guard = [authenticate(), requirePlatformAdmin()];
  router.get(
    '/phone-numbers',
    ...guard,
    ...handle({ query: ListPhoneNumbersQuery }, async ({ query, res }) => {
      ok(res, await listPhoneNumbers(query));
    }),
  );
  router.post(
    '/phone-numbers',
    ...guard,
    ...handle({ body: CreatePhoneNumberBody }, async ({ body, req, res }) => {
      created(res, await createPhoneNumber(req, body));
    }),
  );
  router.patch(
    '/phone-numbers/:id',
    ...guard,
    ...handle(
      { params: PhoneNumberIdParams, body: UpdatePhoneNumberBody },
      async ({ params, body, req, res }) => {
        ok(res, await updatePhoneNumber(req, params.id, body));
      },
    ),
  );
  router.post(
    '/phone-numbers/:id/assign',
    ...guard,
    ...handle(
      { params: PhoneNumberIdParams, body: AssignPhoneNumberBody },
      async ({ params, body, req, res }) => {
        ok(res, await assignPhoneNumber(req, params.id, body));
      },
    ),
  );
  router.post(
    '/phone-numbers/:id/release',
    ...guard,
    ...handle({ params: PhoneNumberIdParams }, async ({ params, req, res }) => {
      ok(res, await releasePhoneNumber(req, params.id));
    }),
  );
  return router;
};

/** `/api/v1/phone-numbers` — the account's own numbers, read-only. */
export const createPhoneNumbersRouter = (): Router => {
  const router = Router();
  router.get('/phone-line', authenticate(), requirePermission('account.read'), async (req, res) => {
    requireAuth(req);
    ok(res, await accountPhoneLine(tenantFilter(req).accountId));
  });
  router.get(
    '/phone-numbers',
    authenticate(),
    requirePermission('account.read'),
    async (req, res) => {
      requireAuth(req);
      ok(res, await accountPhoneNumbers(tenantFilter(req).accountId));
    },
  );
  return router;
};
