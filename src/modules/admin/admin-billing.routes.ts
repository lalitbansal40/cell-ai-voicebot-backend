import { Router, type RequestHandler } from 'express';

import type { Env } from '../../config/env';
import { NotFoundError } from '../../shared/errors/app-error';
import { created, ok } from '../../shared/http/envelope';
import { idempotency, IDEMPOTENCY_HEADER } from '../../shared/middlewares/idempotency';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AccountParams,
  AdjustmentBody,
  AdminLedgerQuery,
  BackToDefaultBody,
  CreditLimitBody,
  HistoryQuery,
  PaymentEventsQuery,
  PaymentsQuery,
  RateCardBody,
  SimulatedCallBody,
  SimulatedEndBody,
  SimulatedHoldParams,
  SummaryQuery,
} from './admin-billing.schema';
import {
  accountRateCardToDefault,
  billingSummary,
  createAccountRateCard,
  createAdjustment,
  defaultRateCardHistory,
  endSimulatedCall,
  getAccountLedger,
  getAccountRateCards,
  getAccountWallet,
  getDefaultRateCard,
  listPaymentEvents,
  listPayments,
  putDefaultRateCard,
  startSimulatedCall,
  updateCreditLimit,
} from './admin-billing.service';

/**
 * Superadmin billing (PHASE_4_PLAN §1j / T4.9). Mounted inside the admin
 * router, so `requirePlatformAdmin()` (never while impersonating) runs first;
 * every route also needs `platform.billing.manage`.
 */
export const createAdminBillingRouter = ({
  env,
}: {
  env: Pick<Env, 'BILLING_SIMULATOR_ENABLED'>;
}): Router => {
  const router = Router();
  const manage = requirePermission('platform.billing.manage');
  /** The simulator does not exist unless enabled (404, not 403). */
  const simulator: RequestHandler = (_req, _res, next) => {
    if (!env.BILLING_SIMULATOR_ENABLED) throw new NotFoundError();
    next();
  };

  router.get('/rate-cards/default', manage, async (_req, res) => {
    ok(res, await getDefaultRateCard());
  });
  router.put(
    '/rate-cards/default',
    manage,
    ...handle({ body: RateCardBody }, async ({ body, req, res }) => {
      ok(res, await putDefaultRateCard(req, body));
    }),
  );
  router.get(
    '/rate-cards/default/history',
    manage,
    ...handle({ query: HistoryQuery }, async ({ query, res }) => {
      ok(res, await defaultRateCardHistory(query.limit));
    }),
  );

  router.get(
    '/accounts/:id/rate-cards',
    manage,
    ...handle({ params: AccountParams, query: HistoryQuery }, async ({ params, query, res }) => {
      ok(res, await getAccountRateCards(params.id, query.limit));
    }),
  );
  router.post(
    '/accounts/:id/rate-cards',
    manage,
    ...handle({ params: AccountParams, body: RateCardBody }, async ({ params, body, req, res }) => {
      created(res, await createAccountRateCard(req, params.id, body));
    }),
  );
  router.delete(
    '/accounts/:id/rate-cards',
    manage,
    ...handle(
      { params: AccountParams, body: BackToDefaultBody },
      async ({ params, body, req, res }) => {
        ok(res, await accountRateCardToDefault(req, params.id, body));
      },
    ),
  );

  router.get(
    '/accounts/:id/wallet',
    manage,
    ...handle({ params: AccountParams }, async ({ params, res }) => {
      ok(res, await getAccountWallet(params.id));
    }),
  );
  router.patch(
    '/accounts/:id/wallet',
    manage,
    ...handle(
      { params: AccountParams, body: CreditLimitBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateCreditLimit(req, params.id, body.creditLimitMicros));
      },
    ),
  );
  router.get(
    '/accounts/:id/ledger',
    manage,
    ...handle(
      { params: AccountParams, query: AdminLedgerQuery },
      async ({ params, query, res }) => {
        const page = await getAccountLedger(params.id, query);
        ok(res, page.items, page.meta);
      },
    ),
  );
  router.post(
    '/accounts/:id/wallet/adjustments',
    manage,
    // keys live in the platform account's namespace; the target id is part of the
    // hashed path, so one key can never be replayed against another account
    idempotency({ scope: (req) => req.auth?.accountId }),
    ...handle(
      { params: AccountParams, body: AdjustmentBody },
      async ({ params, body, req, res }) => {
        const key = req.get(IDEMPOTENCY_HEADER) ?? '';
        created(res, await createAdjustment(req, params.id, key, body));
      },
    ),
  );

  router.post(
    '/accounts/:id/billing/simulated-calls',
    manage,
    simulator,
    ...handle({ params: AccountParams, body: SimulatedCallBody }, async ({ params, body, res }) => {
      created(res, await startSimulatedCall(params.id, body));
    }),
  );
  router.post(
    '/accounts/:id/billing/simulated-calls/:holdId/end',
    manage,
    simulator,
    ...handle(
      { params: SimulatedHoldParams, body: SimulatedEndBody },
      async ({ params, body, res }) => {
        ok(res, await endSimulatedCall(params.id, params.holdId, body));
      },
    ),
  );

  router.get(
    '/billing/summary',
    manage,
    ...handle({ query: SummaryQuery }, async ({ query, req, res }) => {
      ok(res, await billingSummary(req, query));
    }),
  );
  router.get(
    '/payments',
    manage,
    ...handle({ query: PaymentsQuery }, async ({ query, res }) => {
      const page = await listPayments(query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/payment-events',
    manage,
    ...handle({ query: PaymentEventsQuery }, async ({ query, res }) => {
      const page = await listPaymentEvents(query);
      ok(res, page.items, page.meta);
    }),
  );
  return router;
};
