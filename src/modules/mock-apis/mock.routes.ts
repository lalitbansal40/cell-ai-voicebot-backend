import { Router } from 'express';

import type { Env } from '../../config/env';
import { handle } from '../../shared/middlewares/validate';

import {
  HttpStatusParams,
  LoanBalanceQuery,
  PaymentLinkBody,
  PaymentStatusQuery,
} from './mock.schema';
import {
  mockLoanBalance,
  mockPaymentLink,
  mockPaymentStatus,
  normalizeMockPhone,
} from './mock.service';
import { devReceiverUrl, listReceipts, receiveWebhook } from './webhook-receiver';

/**
 * `/api/v1/mock` — DEV ONLY stand-ins for client APIs (no auth). Mounted only
 * when `MOCK_APIS_ENABLED` (env refuses it in production).
 */
export const createMockApisRouter = (
  env: Pick<Env, 'ENCRYPTION_KEY' | 'NODE_ENV' | 'PORT'>,
): Router => {
  const router = Router();
  router.post(
    '/payment-link',
    ...handle({ body: PaymentLinkBody }, ({ body, res }) => {
      res.json(mockPaymentLink(body.loanId, body.amount));
    }),
  );
  // raw body (app.ts) — the signature covers the exact bytes
  router.post('/webhook-receiver', async (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(
        await receiveWebhook(env, raw, {
          signature: req.get('X-Webhook-Signature'),
          timestamp: req.get('X-Webhook-Timestamp'),
          id: req.get('X-Webhook-Id'),
        }),
      );
    } catch (err) {
      next(err);
    }
  });
  router.get('/webhook-receiver', (_req, res) => {
    res.json(listReceipts());
  });
  // the webhook form offers this address as "Dev receiver" (404 when mocks are off)
  router.get('/dev-receiver', (_req, res) => {
    res.json({ url: devReceiverUrl(env) });
  });
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
