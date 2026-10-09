import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { BILLING_LIMITS } from '../../config/limits';
import type { BillingJobs } from '../../core/billing/jobs';
import type { PaymentProvider } from '../../core/payments';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { created, ok } from '../../shared/http/envelope';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter, type RateLimiterOptions } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CreateTopupBody,
  FakeCompleteBody,
  ListTopupsQuery,
  TopupIdParams,
  VerifyTopupBody,
} from './topups.schema';
import { createTopup, fakeComplete, getTopup, listTopups, verifyTopup } from './topups.service';

export interface TopupRouterDeps {
  payments: PaymentProvider;
  jobs: BillingJobs;
  /** Redis store (`rl:topup:`) shared across instances; MemoryStore when omitted. */
  rateLimitStore?: Store;
  rateLimit?: Partial<RateLimiterOptions>;
}

/** `/api/v1/wallet/topups` — recharges (PHASE_4_PLAN §1d). */
export const createTopupsRouter = ({
  payments,
  jobs,
  rateLimitStore,
  rateLimit,
}: TopupRouterDeps): Router => {
  const router = Router();
  const deps = { payments, jobs };
  const ordersPerHour = createRateLimiter({
    windowMs: 60 * 60_000,
    limit: BILLING_LIMITS.topupOrdersPerHour,
    keyGenerator: (req) => `topup:${requireAuth(req).accountId}`,
    ...(rateLimitStore ? { store: rateLimitStore } : {}),
    ...rateLimit,
  });
  router.post(
    '/',
    requirePermission('wallet.topup'),
    blockWhenImpersonating(),
    idempotency({ scope: (req) => req.auth?.accountId }),
    ordersPerHour,
    ...handle({ body: CreateTopupBody }, async ({ body, req, res }) => {
      created(res, await createTopup(req, body, deps));
    }),
  );
  router.get(
    '/',
    requirePermission('wallet.read'),
    ...handle({ query: ListTopupsQuery }, async ({ query, req, res }) => {
      const page = await listTopups(tenantFilter(req).accountId, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/:id',
    requirePermission('wallet.read'),
    ...handle({ params: TopupIdParams }, async ({ params, req, res }) => {
      ok(res, await getTopup(tenantFilter(req).accountId, params.id));
    }),
  );
  router.post(
    '/:id/verify',
    requirePermission('wallet.topup'),
    blockWhenImpersonating(),
    ...handle(
      { params: TopupIdParams, body: VerifyTopupBody },
      async ({ params, body, req, res }) => {
        ok(res, await verifyTopup(req, params.id, body, deps));
      },
    ),
  );
  if (payments.name === 'fake') {
    router.post(
      '/:id/fake-complete',
      requirePermission('wallet.topup'),
      blockWhenImpersonating(),
      ...handle(
        { params: TopupIdParams, body: FakeCompleteBody },
        async ({ params, body, req, res }) => {
          ok(res, await fakeComplete(req, params.id, body, deps));
        },
      ),
    );
  }
  return router;
};
