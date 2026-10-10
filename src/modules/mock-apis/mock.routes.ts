import { Router } from 'express';

import { handle } from '../../shared/middlewares/validate';

import { HttpStatusParams, LoanBalanceQuery, PaymentStatusQuery } from './mock.schema';
import { mockLoanBalance, mockPaymentStatus, normalizeMockPhone } from './mock.service';

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
  router.get(
    '/loan-balance',
    ...handle({ query: LoanBalanceQuery }, ({ query, res }) => {
      res.json(mockLoanBalance(normalizeMockPhone(query.phone)));
    }),
  );
  router.get(
    '/http-status/:code',
    ...handle({ params: HttpStatusParams }, ({ params, res }) => {
      res.status(params.code).json({ code: params.code });
    }),
  );
  return router;
};
