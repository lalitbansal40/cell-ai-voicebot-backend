import { BILLING_LIMITS } from '../../config/limits';
import { RateCardValuesSchema } from '../../core/billing/rates';
import { LEDGER_TYPES } from '../../db/models/ledger-entry.model';
import { PAYMENT_EVENT_OUTCOMES } from '../../db/models/payment-event.model';
import { PAYMENT_PROVIDERS, TOPUP_STATUSES } from '../../db/models/topup-order.model';
import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { TopupOrderSchema } from '../wallet/topups.schema';
import { LedgerEntrySchema, LedgerQuery, WalletSchema } from '../wallet/wallet.schema';

const micros = (max: number) =>
  z.number().int().min(0).max(max).openapi({ description: 'Integer micros (₹1 = 1,000,000)' });

const NOTE = z.string().trim().min(3).max(300).nullable().optional();
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const AccountParams = z.strictObject({ id: ObjectIdSchema });
export const SimulatedHoldParams = z.strictObject({ id: ObjectIdSchema, holdId: ObjectIdSchema });

export const RateCardBody = RateCardValuesSchema.extend({ note: NOTE }).strict();
export const BackToDefaultBody = z.strictObject({ note: NOTE });
export const HistoryQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const AdminLedgerQuery = LedgerQuery;

export const CreditLimitBody = z.strictObject({
  creditLimitMicros: micros(BILLING_LIMITS.creditLimitMaxMicros),
});

export const AdjustmentBody = z.strictObject({
  direction: z.enum(['credit', 'debit']),
  amountMicros: z
    .number()
    .int()
    .min(1)
    .max(BILLING_LIMITS.maxAdjustmentMicros)
    .refine((v) => v % 10_000 === 0, 'Must be a whole number of paise')
    .openapi({ description: 'Integer micros, whole paise, ≤ ₹10 lakh' }),
  reason: z.string().trim().min(5).max(300),
  allowNegative: z.boolean().optional(),
});

export const SimulatedCallBody = z.strictObject({
  estimateMinutes: z.number().int().min(1).max(60).optional(),
});
export const SimulatedEndBody = z.strictObject({
  answered: z.boolean(),
  durationSec: z
    .number()
    .int()
    .min(0)
    .max(4 * 60 * 60),
  aiSeconds: z
    .number()
    .int()
    .min(0)
    .max(4 * 60 * 60)
    .optional(),
  ttsChars: z.number().int().min(0).max(1_000_000).optional(),
});

export const SummaryQuery = z.strictObject({
  month: MONTH.optional().openapi({ description: 'IST month, default: the current one' }),
});

export const PaymentsQuery = z
  .strictObject({
    ...PaginationQuerySchema.shape,
    status: z.enum(TOPUP_STATUSES).optional(),
    account: ObjectIdSchema.optional().openapi({ description: 'Only this account (id)' }),
    from: DATE.optional().openapi({ description: 'IST date (inclusive)' }),
    to: DATE.optional().openapi({ description: 'IST date (inclusive)' }),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['to'],
  });

export const PaymentEventsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  outcome: z.enum(PAYMENT_EVENT_OUTCOMES).optional(),
});

const RateCardValuesView = {
  callPerMinuteMicros: z.number(),
  pulseSeconds: z.number(),
  aiPerMinuteMicros: z.number(),
  ttsPer1kCharsMicros: z.number(),
  commissionBps: z.number(),
  billUnansweredAttempts: z.boolean(),
};

export const RateCardVersionSchema = registry.register(
  'RateCardVersion',
  z.object({
    id: z.string(),
    accountId: z.string().nullable(),
    ...RateCardValuesView,
    inheritsDefault: z.boolean(),
    effectiveFrom: z.string(),
    createdBy: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const AccountRateCardsSchema = registry.register(
  'AccountRateCards',
  z.object({
    effective: z.object({
      id: z.string(),
      source: z.enum(['account', 'default']),
      ...RateCardValuesView,
      effectiveFrom: z.string(),
    }),
    history: z.array(RateCardVersionSchema),
  }),
);

export const AdjustmentResultSchema = registry.register(
  'WalletAdjustment',
  z.object({ entry: LedgerEntrySchema, wallet: WalletSchema }),
);

export const SimulatedHoldSchema = registry.register(
  'SimulatedHold',
  z.object({
    holdId: z.string(),
    heldMicros: z.number(),
    rateCard: AccountRateCardsSchema.shape.effective,
    wallet: WalletSchema,
  }),
);

export const SimulatedEndSchema = registry.register(
  'SimulatedCallResult',
  z.object({
    outcome: z.enum(['charged', 'released']),
    entries: z.array(LedgerEntrySchema),
    wallet: WalletSchema,
  }),
);

const Money = z.object({
  count: z.number(),
  baseMicros: z.number(),
  cgstMicros: z.number(),
  sgstMicros: z.number(),
  igstMicros: z.number(),
  taxMicros: z.number(),
  totalMicros: z.number(),
});

export const BillingSummarySchema = registry.register(
  'BillingSummary',
  z.object({
    month: z.string(),
    from: z.string(),
    to: z.string(),
    topups: Money,
    usage: z.object({
      byType: z.array(z.object({ type: z.enum(LEDGER_TYPES), amountMicros: z.number() })),
      totalMicros: z.number(),
    }),
    adjustments: z.object({ creditMicros: z.number(), debitMicros: z.number() }),
    topAccounts: z.array(
      z.object({ accountId: z.string(), name: z.string(), spendMicros: z.number() }),
    ),
    wallets: z.object({ total: z.number(), low: z.number(), exhausted: z.number() }),
    openReconcileMismatches: z.number(),
    paymentEventsNeedingAttention: z.number(),
  }),
);

export const AdminPaymentSchema = registry.register(
  'AdminPayment',
  TopupOrderSchema.extend({
    accountId: z.string(),
    accountName: z.string().nullable(),
    providerPaymentId: z.string().nullable(),
  }),
);

export const PaymentEventSchema = registry.register(
  'PaymentEvent',
  z.object({
    id: z.string(),
    provider: z.enum(PAYMENT_PROVIDERS),
    eventId: z.string(),
    type: z.string(),
    accountId: z.string().nullable(),
    topupOrderId: z.string().nullable(),
    providerOrderId: z.string().nullable(),
    providerPaymentId: z.string().nullable(),
    outcome: z.enum(PAYMENT_EVENT_OUTCOMES),
    receivedAt: z.string(),
    processedAt: z.string().nullable(),
  }),
);

export const BillingConfigSchema = registry.register(
  'AdminBillingConfig',
  z.object({
    simulatorEnabled: z.boolean(),
    paymentProvider: z.enum(PAYMENT_PROVIDERS),
  }),
);

const tags = ['Superadmin billing'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const guard = { 401: errors[401], 403: errors[403] };
const account = { params: AccountParams };

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/rate-cards/default',
  tags,
  summary: 'Platform default rate card in force (platform.billing.manage)',
  security: bearer,
  responses: { 200: ok(RateCardVersionSchema), ...guard },
});
registry.registerPath({
  method: 'put',
  path: '/api/v1/admin/rate-cards/default',
  tags,
  summary: 'New default rate card version (history kept; every account on the default sees it)',
  security: bearer,
  request: json(RateCardBody),
  responses: { 200: ok(RateCardVersionSchema), ...guard, 422: errors[422] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/rate-cards/default/history',
  tags,
  summary: 'Default rate card versions, newest first',
  security: bearer,
  request: { query: HistoryQuery },
  responses: { 200: ok(z.array(RateCardVersionSchema)), ...guard },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts/{id}/rate-cards',
  tags,
  summary: 'Prices in force for an account + its override history',
  security: bearer,
  request: { ...account, query: HistoryQuery },
  responses: { 200: ok(AccountRateCardsSchema), ...guard, 404: errors[404] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/rate-cards',
  tags,
  summary: 'New account override',
  security: bearer,
  request: { ...account, ...json(RateCardBody) },
  responses: { 201: ok(AccountRateCardsSchema), ...guard, 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/admin/accounts/{id}/rate-cards',
  tags,
  summary: 'Back to the platform default (history kept)',
  security: bearer,
  request: { ...account, ...json(BackToDefaultBody) },
  responses: { 200: ok(AccountRateCardsSchema), ...guard, 404: errors[404], 409: errors[409] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts/{id}/wallet',
  tags,
  summary: 'An account’s wallet',
  security: bearer,
  request: account,
  responses: { 200: ok(WalletSchema), ...guard, 404: errors[404] },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/wallet',
  tags,
  summary: 'Credit limit (≤ ₹1 lakh)',
  security: bearer,
  request: { ...account, ...json(CreditLimitBody) },
  responses: { 200: ok(WalletSchema), ...guard, 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts/{id}/ledger',
  tags,
  summary: 'An account’s ledger, newest first (keyset cursor)',
  security: bearer,
  request: { ...account, query: AdminLedgerQuery },
  responses: {
    200: {
      description: 'Entries',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(LedgerEntrySchema),
            meta: CursorPageMetaSchema,
          }),
        },
      },
    },
    ...guard,
    404: errors[404],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/wallet/adjustments',
  tags,
  summary:
    'Manual credit / debit with a reason (Idempotency-Key required; audited on both accounts)',
  security: bearer,
  request: {
    ...account,
    headers: z.object({ 'idempotency-key': z.string().min(1).max(255) }),
    ...json(AdjustmentBody),
  },
  responses: {
    201: ok(AdjustmentResultSchema),
    ...guard,
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/billing/simulated-calls',
  tags,
  summary: 'Start a simulated call: a real hold (404 unless BILLING_SIMULATOR_ENABLED)',
  security: bearer,
  request: { ...account, ...json(SimulatedCallBody) },
  responses: { 201: ok(SimulatedHoldSchema), ...guard, 404: errors[404], 409: errors[409] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/billing/simulated-calls/{holdId}/end',
  tags,
  summary: 'End a simulated call: settle (answered / billable) or release the hold',
  security: bearer,
  request: { params: SimulatedHoldParams, ...json(SimulatedEndBody) },
  responses: { 200: ok(SimulatedEndSchema), ...guard, 404: errors[404], 409: errors[409] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/billing/config',
  tags,
  summary: 'What this server allows: billing simulator on / off, payment provider',
  security: bearer,
  responses: { 200: ok(BillingConfigSchema), ...guard },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/billing/summary',
  tags,
  summary: 'Platform month totals (IST): top-ups + GST, usage, top accounts, wallet health',
  security: bearer,
  request: { query: SummaryQuery },
  responses: { 200: ok(BillingSummarySchema), ...guard },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/payments',
  tags,
  summary: 'Top-up orders of every account',
  security: bearer,
  request: { query: PaymentsQuery },
  responses: { 200: okPage(AdminPaymentSchema), ...guard },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/payment-events',
  tags,
  summary: 'Payment webhook deliveries (kept 90 days)',
  security: bearer,
  request: { query: PaymentEventsQuery },
  responses: { 200: okPage(PaymentEventSchema), ...guard },
});
