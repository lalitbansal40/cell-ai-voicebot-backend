import { Router, type Request, type Response } from 'express';

import type { BillingJobs } from '../../core/billing/jobs';
import type { PaymentProvider } from '../../core/payments';
import { ValidationError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';

import { handlePaymentWebhook } from './webhooks.service';

/**
 * `/api/v1/webhooks/razorpay` — public, authenticated by the signature only.
 * `app.ts` mounts a raw-body parser for this path BEFORE the JSON parser.
 */
export const createWebhooksRouter = ({
  payments,
  jobs,
}: {
  payments: PaymentProvider;
  jobs: BillingJobs;
}): Router => {
  const router = Router();
  router.post('/razorpay', async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      throw new ValidationError([{ path: 'body', message: 'Expected an application/json body' }]);
    }
    const result = await handlePaymentWebhook({
      payments,
      jobs,
      rawBody: req.body,
      signature: req.get('x-razorpay-signature') ?? undefined,
      eventId: req.get('x-razorpay-event-id') ?? undefined,
    });
    ok(res, result);
  });
  return router;
};
