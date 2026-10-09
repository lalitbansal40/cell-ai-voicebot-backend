import { BILLING_LIMITS } from '../../config/limits';
import {
  LEDGER_DIRECTIONS,
  LEDGER_REF_TYPES,
  LEDGER_STATUSES,
  LEDGER_TYPES,
} from '../../db/models/ledger-entry.model';
import { PULSE_SECONDS } from '../../db/models/rate-card.model';
import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { CursorQuerySchema, ObjectIdSchema } from '../../shared/validation/schemas';

const micros = (max: number) =>
  z.number().int().min(0).max(max).openapi({ description: 'Integer micros (₹1 = 1,000,000)' });

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const WalletSchema = registry.register(
  'Wallet',
  z.object({
    currency: z.literal('INR'),
    balanceMicros: z.number(),
    holdMicros: z.number(),
    availableMicros: z.number().openapi({ description: 'balance + credit limit − hold' }),
    creditLimitMicros: z.number(),
    status: z.enum(['ok', 'low', 'exhausted']),
    lowBalanceThresholdMicros: z.number(),
    budgets: z.object({ monthlyCallMicros: z.number(), monthlyAiMicros: z.number() }),
    monthSpend: z.object({
      month: z.string().openapi({ example: '2026-10' }),
      callMicros: z.number(),
      aiMicros: z.number(),
      ttsMicros: z.number(),
      totalMicros: z.number(),
    }),
    updatedAt: z.string(),
  }),
);

export const WalletSettingsBody = z
  .strictObject({
    lowBalanceThresholdMicros: micros(BILLING_LIMITS.thresholdMaxMicros).optional(),
    budgets: z
      .strictObject({
        monthlyCallMicros: micros(BILLING_LIMITS.budgetMaxMicros).optional(),
        monthlyAiMicros: micros(BILLING_LIMITS.budgetMaxMicros).optional(),
      })
      .optional(),
  })
  .refine(
    (b) =>
      b.lowBalanceThresholdMicros !== undefined || (b.budgets && Object.keys(b.budgets).length > 0),
    'Nothing to update',
  );

export const RateCardViewSchema = registry.register(
  'RateCardView',
  z.object({
    callPerMinuteMicros: z.number(),
    pulseSeconds: z.union(
      PULSE_SECONDS.map((p) => z.literal(p)) as [
        z.ZodLiteral<15>,
        z.ZodLiteral<30>,
        z.ZodLiteral<60>,
      ],
    ),
    aiPerMinuteMicros: z.number(),
    ttsPer1kCharsMicros: z.number(),
    commissionBps: z.number(),
    billUnansweredAttempts: z.boolean(),
    source: z.enum(['account', 'default']),
    effectiveFrom: z.string(),
  }),
);

export const EstimateBody = z.strictObject({
  calls: z.number().int().min(1).max(1_000_000),
  avgDurationSec: z.number().int().min(1).max(3600),
  answerRateBps: z.number().int().min(0).max(10_000).default(5000),
  aiShareBps: z.number().int().min(0).max(10_000).default(10_000),
});

export const EstimateSchema = registry.register(
  'WalletEstimate',
  z.object({
    answeredCalls: z.number(),
    billableSeconds: z.number(),
    perCallMicros: z.number(),
    totalMicros: z.number(),
    holdPerCallMicros: z.number(),
    availableMicros: z.number(),
  }),
);

const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

export const LedgerQuery = z
  .strictObject({
    ...CursorQuerySchema.shape,
    type: csvOf(LEDGER_TYPES).optional().openapi({ description: 'Comma-separated types' }),
    status: z.enum(LEDGER_STATUSES).optional(),
    refType: z.enum(LEDGER_REF_TYPES).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: 'from must be before to',
    path: ['to'],
  });

export const LedgerIdParams = z.strictObject({ id: ObjectIdSchema });

export const LedgerExportQuery = z
  .strictObject({ from: DATE, to: DATE })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] });

export const UsageQuery = z
  .strictObject({ from: DATE.optional(), to: DATE.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['to'],
  });

export const LedgerEntrySchema = registry.register(
  'LedgerEntry',
  z.object({
    id: z.string(),
    type: z.enum(LEDGER_TYPES),
    direction: z.enum(LEDGER_DIRECTIONS),
    status: z.enum(LEDGER_STATUSES),
    amountMicros: z.number(),
    currency: z.literal('INR'),
    balanceAfterMicros: z.number().nullable(),
    breakdown: z
      .object({
        telephonyMicros: z.number().optional(),
        aiMicros: z.number().optional(),
        ttsMicros: z.number().optional(),
        commissionMicros: z.number().optional(),
        answered: z.boolean().optional(),
        durationSec: z.number().optional(),
        billableSeconds: z.number().optional(),
        pulseSeconds: z.number().optional(),
        aiSeconds: z.number().optional(),
        ttsChars: z.number().optional(),
      })
      .nullable(),
    ref: z.object({ type: z.enum(LEDGER_REF_TYPES), id: z.string() }),
    holdId: z.string().nullable(),
    description: z.string().openapi({ example: 'Call charge' }),
    note: z.string().nullable(),
    createdBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
    releasedAt: z.string().nullable(),
    releaseReason: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const UsageSeriesSchema = registry.register(
  'UsageSeries',
  z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
    series: z.array(
      z.object({
        date: z.string(),
        callMicros: z.number(),
        aiMicros: z.number(),
        ttsMicros: z.number(),
        otherMicros: z.number(),
        totalMicros: z.number(),
      }),
    ),
    totals: z.object({
      callMicros: z.number(),
      aiMicros: z.number(),
      ttsMicros: z.number(),
      otherMicros: z.number(),
      totalMicros: z.number(),
    }),
  }),
);

const tags = ['Wallet'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet',
  tags,
  summary: 'Balance, hold, available, status, budgets and this month’s spend (wallet.read)',
  security: bearer,
  responses: { 200: ok(WalletSchema), 401: errors[401], 403: errors[403] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/wallet/settings',
  tags,
  summary: 'Low-balance threshold and monthly budgets (wallet.topup; not while impersonating)',
  security: bearer,
  request: json(WalletSettingsBody),
  responses: { 200: ok(WalletSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/rates',
  tags,
  summary: 'Prices that apply to this account (wallet.read)',
  security: bearer,
  responses: { 200: ok(RateCardViewSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/wallet/estimate',
  tags,
  summary: 'Cost estimate for a number of calls (wallet.read)',
  security: bearer,
  request: json(EstimateBody),
  responses: { 200: ok(EstimateSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/ledger',
  tags,
  summary: 'Money movements, newest first (wallet.read, cursor pagination)',
  security: bearer,
  request: { query: LedgerQuery },
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
    403: errors[403],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/ledger/export',
  tags,
  summary: `Ledger as CSV for a date range (account timezone, ≤ ${BILLING_LIMITS.ledgerExportMaxDays} days)`,
  security: bearer,
  request: { query: LedgerExportQuery },
  responses: {
    200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } },
    403: errors[403],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/ledger/{id}',
  tags,
  summary: 'One ledger entry',
  security: bearer,
  request: { params: LedgerIdParams },
  responses: { 200: ok(LedgerEntrySchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/wallet/usage',
  tags,
  summary: 'Daily usage (call / AI / TTS) in the account timezone — default this month',
  security: bearer,
  request: { query: UsageQuery },
  responses: { 200: ok(UsageSeriesSchema), 403: errors[403], 422: errors[422] },
});
