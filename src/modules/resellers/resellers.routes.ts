import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { requireAuth } from '../../shared/auth/auth-context';
import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockSensitiveWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CreateCustomerBody,
  CreditBody,
  CustomerIdParams,
  ListCustomersQuery,
  OwnerPasswordBody,
  ResellerSettingsBody,
  StatementQuery,
  UpdateCustomerBody,
} from './resellers.schema';
import {
  createCustomer,
  customerCredit,
  customerDetail,
  getSettings,
  listCustomers,
  loginAsCustomer,
  resetOwnerPassword,
  statement,
  statementCsv,
  summary,
  updateCustomer,
  updateSettings,
} from './resellers.service';

/**
 * `/api/v1/reseller/*` (Phase 19): only on reseller accounts (else 404); never from a
 * login-as session (a reseller panel inside a customer makes no sense, and money moves).
 */
export const createResellerRouter = (stores: { create?: Store; credit?: Store } = {}): Router => {
  const router = Router();
  router.use(authenticate(), blockSensitiveWhenImpersonating());
  const read = requirePermission('reseller.read');
  const manage = requirePermission('reseller.manage');
  const scope = (req: { auth?: { accountId: string } }) => req.auth?.accountId;
  const limit = (name: string, max: number, windowMs: number, store?: Store) =>
    createRateLimiter({
      limit: max,
      windowMs,
      keyGenerator: (req) => `${name}:${requireAuth(req).accountId}`,
      ...(store ? { store } : {}),
    });

  router.get('/summary', read, async (req, res) => {
    ok(res, await summary(req));
  });
  router.get(
    '/customers',
    read,
    ...handle({ query: ListCustomersQuery }, async ({ req, res, query }) => {
      const page = await listCustomers(req, query);
      ok(res, page.data, page.meta);
    }),
  );
  router.post(
    '/customers',
    manage,
    limit('reseller-customer-create', 50, 86_400_000, stores.create),
    idempotency({ scope }),
    ...handle({ body: CreateCustomerBody }, async ({ req, res, body }) => {
      created(res, await createCustomer(req, body));
    }),
  );
  router.get(
    '/customers/:id',
    read,
    ...handle({ params: CustomerIdParams }, async ({ req, res, params }) => {
      ok(res, await customerDetail(req, params.id));
    }),
  );
  router.patch(
    '/customers/:id',
    manage,
    ...handle(
      { params: CustomerIdParams, body: UpdateCustomerBody },
      async ({ req, res, params, body }) => {
        ok(res, await updateCustomer(req, params.id, body));
      },
    ),
  );
  router.post(
    '/customers/:id/owner-password',
    manage,
    ...handle(
      { params: CustomerIdParams, body: OwnerPasswordBody },
      async ({ req, res, params, body }) => {
        await resetOwnerPassword(req, params.id, body.password);
        noContent(res);
      },
    ),
  );
  router.post(
    '/customers/:id/login-as',
    manage,
    limit('login-as', 30, 3_600_000),
    ...handle({ params: CustomerIdParams }, async ({ req, res, params }) => {
      res.set('Cache-Control', 'no-store');
      ok(res, await loginAsCustomer(req, params.id));
    }),
  );
  const creditLimit = limit('reseller-credit', 60, 3_600_000, stores.credit);
  for (const [suffix, way] of [
    ['credit', 'give'],
    ['credit/reclaim', 'take'],
  ] as const) {
    router.post(
      `/customers/:id/${suffix}`,
      manage,
      creditLimit,
      ...handle(
        { params: CustomerIdParams, body: CreditBody },
        async ({ req, res, params, body }) => {
          ok(
            res,
            await customerCredit(
              req,
              params.id,
              body,
              way,
              req.get('idempotency-key') ?? undefined,
            ),
          );
        },
      ),
    );
  }
  router.get(
    '/statement',
    read,
    ...handle({ query: StatementQuery }, async ({ req, res, query }) => {
      if (query.format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="reseller-statement.csv"');
        res.send(await statementCsv(req, query));
        return;
      }
      ok(res, await statement(req, query));
    }),
  );
  router.get('/settings', read, async (req, res) => {
    ok(res, await getSettings(req));
  });
  router.patch(
    '/settings',
    manage,
    ...handle({ body: ResellerSettingsBody }, async ({ req, res, body }) => {
      ok(res, await updateSettings(req, body));
    }),
  );
  return router;
};
