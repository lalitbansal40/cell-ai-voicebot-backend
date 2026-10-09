import { PAYMENT_EVENT_OUTCOMES } from '../../db/models/payment-event.model';
import { registry } from '../../shared/openapi/registry';
import { errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/razorpay',
  tags: ['Webhooks'],
  summary: 'Razorpay payment events (public — authenticated by the signature of the raw body)',
  security: [],
  request: {
    headers: z.object({
      'X-Razorpay-Signature': z.string().openapi({ description: 'HMAC-SHA256 of the raw body' }),
      'X-Razorpay-Event-Id': z
        .string()
        .optional()
        .openapi({ description: 'Used to drop duplicate deliveries' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: z
            .object({ event: z.string(), payload: z.record(z.string(), z.unknown()) })
            .openapi({ description: 'Razorpay event (max 256 KB)' }),
        },
      },
    },
  },
  responses: {
    200: ok(z.object({ duplicate: z.boolean(), outcome: z.enum(PAYMENT_EVENT_OUTCOMES) })),
    401: errors[401],
    413: errors[413],
    422: errors[422],
  },
});
