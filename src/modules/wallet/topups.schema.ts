import { BILLING_LIMITS } from '../../config/limits';
import { PAYMENT_PROVIDERS, TOPUP_STATUSES } from '../../db/models/topup-order.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';

export const CreateTopupBody = z.strictObject({
  amountMicros: z
    .number()
    .int()
    .min(BILLING_LIMITS.topupMinMicros, { message: 'Minimum is ₹100' })
    .max(BILLING_LIMITS.topupMaxMicros, { message: 'Maximum is ₹5,00,000' })
    .refine((v) => v % 1_000_000 === 0, 'Whole rupees only')
    .openapi({
      description: 'Wallet credit (before GST), whole rupees in micros',
      example: 1_000_000_000,
    }),
});

export const TopupIdParams = z.strictObject({ id: ObjectIdSchema });

export const VerifyTopupBody = z.strictObject({
  providerPaymentId: z.string().min(1).max(100),
  signature: z.string().min(1).max(200),
});

export const FakeCompleteBody = z.strictObject({ outcome: z.enum(['paid', 'failed']) });

export const ListTopupsQuery = z.strictObject({ ...PaginationQuerySchema.shape });

export const TopupOrderSchema = registry.register(
  'TopupOrder',
  z.object({
    id: z.string(),
    provider: z.enum(PAYMENT_PROVIDERS),
    providerOrderId: z.string().nullable(),
    status: z.enum(TOPUP_STATUSES),
    baseMicros: z.number(),
    cgstMicros: z.number(),
    sgstMicros: z.number(),
    igstMicros: z.number(),
    taxMicros: z.number(),
    totalMicros: z.number(),
    currency: z.literal('INR'),
    failureReason: z.string().nullable(),
    paidAt: z.string().nullable(),
    invoiceId: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const TopupCheckoutSchema = registry.register(
  'TopupCheckout',
  z.object({
    topupOrder: TopupOrderSchema,
    checkout: z.object({
      provider: z.enum(PAYMENT_PROVIDERS),
      keyId: z
        .string()
        .nullable()
        .openapi({ description: 'Razorpay key id (public); null for test payments' }),
      providerOrderId: z.string(),
      amountPaise: z.number(),
      currency: z.literal('INR'),
      name: z.string(),
      description: z.string(),
      prefill: z.object({ name: z.string(), email: z.string() }),
    }),
  }),
);

const tags = ['Wallet'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const idempotencyHeader = z.object({
  'Idempotency-Key': z.string().min(1).max(255).openapi({ description: 'Required (api.md §10)' }),
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/wallet/topups',
  tags,
  summary: 'Start a wallet recharge — creates a payment order (wallet.topup; Idempotency-Key)',
  security: bearer,
  request: { headers: idempotencyHeader, ...json(CreateTopupBody) },
  responses: {
    201: ok(TopupCheckoutSchema, 'Created'),
    403: errors[403],
    422: errors[422],
    429: errors[429],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/topups',
  tags,
  summary: 'Recharge history (wallet.read)',
  security: bearer,
  request: { query: ListTopupsQuery },
  responses: { 200: okPage(TopupOrderSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/topups/{id}',
  tags,
  summary: 'One recharge (poll it after checkout)',
  security: bearer,
  request: { params: TopupIdParams },
  responses: { 200: ok(TopupOrderSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/wallet/topups/{id}/verify',
  tags,
  summary: 'Confirm a checkout payment (signature + payment re-fetched from the gateway)',
  security: bearer,
  request: { params: TopupIdParams, ...json(VerifyTopupBody) },
  responses: {
    200: ok(TopupOrderSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/wallet/topups/{id}/fake-complete',
  tags,
  summary: 'Test payments only (PAYMENT_PROVIDER=fake): pay or fail an order',
  security: bearer,
  request: { params: TopupIdParams, ...json(FakeCompleteBody) },
  responses: { 200: ok(TopupOrderSchema), 404: errors[404], 409: errors[409] },
});
