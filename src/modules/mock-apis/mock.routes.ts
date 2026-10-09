import { Router } from 'express';

import { handle } from '../../shared/middlewares/validate';

import { PaymentStatusQuery } from './mock.schema';
import { mockPaymentStatus, normalizeMockPhone } from './mock.service';

/**
 * `/api/v1/mock` — DEV ONLY stand-ins for client APIs (no auth). Mounted only
 * when `MOCK_APIS_ENABLED` (env refuses it in production).
 */
export const createMockApisRouter = (): Router => {
  const router = Router();
  router.get(
    '/payment-status',
    ...handle({ query: PaymentStatusQuery }, async ({ query, res }) => {
      res.json(await mockPaymentStatus(normalizeMockPhone(query.phone), query.loanId ?? null));
    }),
  );
  return router;
};
