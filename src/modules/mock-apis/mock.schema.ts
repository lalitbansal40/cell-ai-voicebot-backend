import { registry } from '../../shared/openapi/registry';
import { errors } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

export const PaymentStatusQuery = z.strictObject({
  phone: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{6,14}$/, 'Use the +91… format')
    .openapi({ example: '+919000000001' }),
  loanId: z.string().trim().min(1).max(60).optional(),
});

export const MockPaymentStatusSchema = registry.register(
  'MockPaymentStatus',
  z.object({
    found: z
      .boolean()
      .openapi({ description: 'A seeded record answered (else the even / odd rule)' }),
    status: z.enum(['paid', 'unpaid', 'partial']),
    amountRupees: z.number(),
    paidOn: z.string().nullable().openapi({ description: 'YYYY-MM-DD' }),
    loanId: z.string().nullable(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/mock/payment-status',
  tags: ['Mock APIs (dev only)'],
  summary:
    'DEV ONLY — mock client payment API for agent templates and E2E. Not mounted in production (404). Plain JSON, no envelope.',
  security: [],
  request: { query: PaymentStatusQuery },
  responses: {
    200: {
      description: 'Payment status',
      content: { 'application/json': { schema: MockPaymentStatusSchema } },
    },
    422: errors[422],
  },
});
