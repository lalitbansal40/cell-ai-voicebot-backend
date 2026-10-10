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

export const LoanBalanceQuery = PaymentStatusQuery.pick({ phone: true });

export const HttpStatusParams = z.strictObject({
  code: z.coerce.number().int().min(200).max(599).openapi({ example: 500 }),
});

export const MockLoanBalanceSchema = registry.register(
  'MockLoanBalance',
  z.object({
    found: z.literal(true),
    outstandingRupees: z.number(),
    dueDate: z.string().openapi({ description: 'YYYY-MM-DD' }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/mock/loan-balance',
  tags: ['Mock APIs (dev only)'],
  summary:
    'DEV ONLY — mock loan balance (odd last digit → ₹2,500 outstanding, even → 0; due in 5 days IST) for the Inbound support flow template. Not mounted in production.',
  security: [],
  request: { query: LoanBalanceQuery },
  responses: {
    200: {
      description: 'Loan balance',
      content: { 'application/json': { schema: MockLoanBalanceSchema } },
    },
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/mock/http-status/{code}',
  tags: ['Mock APIs (dev only)'],
  summary:
    'DEV ONLY — answers with the given status (200–599) and `{ code }`; used to test failure edges of API request nodes. Not mounted in production.',
  security: [],
  request: { params: HttpStatusParams },
  responses: {
    200: {
      description: 'The requested status (any 2xx–5xx)',
      content: { 'application/json': { schema: z.object({ code: z.number() }) } },
    },
    422: errors[422],
  },
});
