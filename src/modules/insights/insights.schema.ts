import { INSIGHTS_LIMITS } from '../../config/limits';
import type { CallInsightOutput } from '../../db/models/call-insight.model';
import { INSIGHT_STATUSES, SENTIMENTS, DISPOSITION_SOURCES } from '../../db/models/call.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

// ── What the model answers (lenient where safe: long text is cut, numbers clamped) ──

const cut = (max: number) =>
  z
    .string()
    .nullable()
    .transform((s) => (s === null ? null : s.trim().slice(0, max) || null));
const unit = z.number().transform((n) => Math.min(1, Math.max(0, n)));

export const ModelInsightsSchema = z.strictObject({
  summary: z.string().transform((s) => s.trim().slice(0, INSIGHTS_LIMITS.summaryMaxChars)),
  suggestedDisposition: z.string().nullable(),
  sentiment: z.strictObject({
    label: z.enum(SENTIMENTS),
    score: z.number().transform((n) => Math.min(1, Math.max(-1, n))),
  }),
  keyInfo: z.strictObject({
    promiseDate: z
      .string()
      .nullable()
      .transform((s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)),
    promiseAmountRupees: z.number().nullable(),
    callbackAt: z
      .string()
      .nullable()
      .transform((s) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null)),
    disputeReason: cut(200),
    wrongNumber: z.boolean(),
    languagePreference: cut(20),
    notes: cut(300),
  }),
  confidence: z.strictObject({ disposition: unit, promise: unit, sentiment: unit }),
});

/** Model JSON → what we store: amounts in micros (whole paise), unknown outcome keys dropped. */
export const toInsightOutput = (
  raw: z.infer<typeof ModelInsightsSchema>,
  allowedKeys: readonly string[],
): CallInsightOutput => {
  const rupees = raw.keyInfo.promiseAmountRupees;
  return {
    summary: raw.summary,
    suggestedDisposition:
      raw.suggestedDisposition && allowedKeys.includes(raw.suggestedDisposition)
        ? raw.suggestedDisposition
        : null,
    sentiment: raw.sentiment,
    keyInfo: {
      promiseDate: raw.keyInfo.promiseDate,
      promiseAmountMicros:
        rupees !== null && Number.isFinite(rupees) && rupees > 0 && rupees < 1e9
          ? Math.round(rupees * 100) * 10_000
          : null,
      callbackAt: raw.keyInfo.callbackAt,
      disputeReason: raw.keyInfo.disputeReason,
      wrongNumber: raw.keyInfo.wrongNumber,
      languagePreference: raw.keyInfo.languagePreference,
      notes: raw.keyInfo.notes,
    },
    confidence: raw.confidence,
  };
};

// ── API ─────────────────────────────────────────────────────────────────────

export const InsightParams = z.strictObject({ id: ObjectIdSchema });

export const DispositionBody = z.strictObject({
  disposition: z.string().regex(/^[a-z0-9_]{1,40}$/),
});

export const InsightsSettingsBody = z
  .strictObject({
    enabled: z.boolean().optional(),
    chatSummaryOnClose: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

const DispositionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(INSIGHTS_LIMITS.dispositionLabelMax),
  active: z.boolean(),
});

export const DispositionsBody = z.strictObject({
  dispositions: z
    .array(DispositionSchema)
    .min(1)
    .max(INSIGHTS_LIMITS.dispositionsMax)
    .refine((list) => new Set(list.map((d) => d.key)).size === list.length, {
      message: 'Keys must be unique',
    }),
});

const OutputSchema = z.object({
  summary: z.string(),
  suggestedDisposition: z.string().nullable(),
  sentiment: z.object({ label: z.enum(SENTIMENTS), score: z.number() }),
  keyInfo: z.object({
    promiseDate: z.string().nullable(),
    promiseAmountMicros: z.number().int().nullable(),
    callbackAt: z.string().nullable(),
    disputeReason: z.string().nullable(),
    wrongNumber: z.boolean(),
    languagePreference: z.string().nullable(),
    notes: z.string().nullable(),
  }),
  confidence: z.object({ disposition: z.number(), promise: z.number(), sentiment: z.number() }),
});

export const InsightVersionSchema = registry.register(
  'CallInsightVersion',
  z.object({
    version: z.number().int(),
    status: z.enum(INSIGHT_STATUSES),
    reason: z.string().nullable(),
    output: OutputSchema.nullable(),
    model: z.string().nullable(),
    costMicros: z.number().int(),
    createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdAt: z.string(),
  }),
);

export const CallInsightsViewSchema = registry.register(
  'CallInsights',
  z.object({
    callId: z.string(),
    status: z.enum(INSIGHT_STATUSES).nullable(),
    reason: z.string().nullable(),
    disposition: z.string().nullable(),
    dispositionSource: z.enum(DISPOSITION_SOURCES).nullable(),
    latest: InsightVersionSchema.nullable(),
    history: z.array(InsightVersionSchema),
    canRegenerate: z.boolean(),
  }),
);

export const InsightsSettingsSchema = registry.register(
  'InsightsSettings',
  z.object({
    enabled: z.boolean(),
    chatSummaryOnClose: z.boolean(),
    transcribeHumanCalls: z.boolean(),
  }),
);

export const DispositionsSchema = registry.register(
  'Dispositions',
  z.object({ dispositions: z.array(DispositionSchema) }),
);

// ── OpenAPI paths ───────────────────────────────────────────────────────────

const tags = ['Insights'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/calls/{id}/insights',
  tags,
  summary: 'Post-call AI insights of a call: latest version + history (calls.read)',
  security: bearer,
  request: { params: InsightParams },
  responses: {
    200: ok(CallInsightsViewSchema),
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/calls/{id}/insights/regenerate',
  tags,
  summary:
    'Run the insights again as a new version (calls.listen; uses AI credit; 409 INSIGHTS_NOT_AVAILABLE / INSIGHTS_DISABLED, 422 WALLET_INSUFFICIENT_BALANCE)',
  security: bearer,
  request: { params: InsightParams },
  responses: {
    202: ok(CallInsightsViewSchema, 'Queued'),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/calls/{id}/disposition',
  tags,
  summary:
    "Set the call's outcome by hand (calls.trigger; an active disposition key; 422 DISPOSITION_UNKNOWN)",
  security: bearer,
  request: { params: InsightParams, ...json(DispositionBody) },
  responses: {
    200: ok(CallInsightsViewSchema),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/account/insights-settings',
  tags,
  summary: 'Post-call AI settings (account.read)',
  security: bearer,
  responses: { 200: ok(InsightsSettingsSchema), 401: errors[401], 403: errors[403] },
});
registry.registerPath({
  method: 'put',
  path: '/api/v1/account/insights-settings',
  tags,
  summary: 'Turn post-call AI / chat summaries on close on or off (account.update)',
  security: bearer,
  request: json(InsightsSettingsBody),
  responses: {
    200: ok(InsightsSettingsSchema),
    401: errors[401],
    403: errors[403],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/account/dispositions',
  tags,
  summary: "The account's call outcomes (account.read)",
  security: bearer,
  responses: { 200: ok(DispositionsSchema), 401: errors[401], 403: errors[403] },
});
registry.registerPath({
  method: 'put',
  path: '/api/v1/account/dispositions',
  tags,
  summary: `Replace the call outcomes (account.update; ≤ ${String(INSIGHTS_LIMITS.dispositionsMax)}; keys in use can't be removed — deactivate them)`,
  security: bearer,
  request: json(DispositionsBody),
  responses: { 200: ok(DispositionsSchema), 401: errors[401], 403: errors[403], 422: errors[422] },
});
