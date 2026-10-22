import { CAMPAIGN_LIMITS } from '../../config/limits';
import { DISPOSITIONS } from '../../db/models/ai-agent.model';
import {
  CALL_RESULTS,
  CAMPAIGN_CONTACT_STATUSES,
  WAIT_REASONS,
} from '../../db/models/campaign-contact.model';
import {
  CAMPAIGN_MODES,
  CAMPAIGN_PRIORITIES,
  CAMPAIGN_STATUSES,
  DRY_RUN_OUTCOMES,
  PAUSE_REASONS,
  RECURRENCE_FREQS,
  RETRY_ON,
  SCENARIO_KEYS,
  SKIP_REASONS,
  VERSION_POLICIES,
} from '../../db/models/campaign.model';
import { EXPORT_FORMATS } from '../../db/models/export-job.model';
import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { CursorQuerySchema, ObjectIdSchema } from '../../shared/validation/schemas';
import { CallingWindowInput } from '../account/account.schema';
import { TimezoneSchema } from '../auth/auth.schema';
import { ExportJobSchema } from '../contact-exports/contact-exports.schema';
import { ContactFilterSchema } from '../contacts/filter/filter.schema';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const iso = z.iso.datetime({ offset: true });
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const CampaignParams = z.strictObject({ id: ObjectIdSchema });

/**
 * Every settings group is optional: create fills the defaults
 * (PHASE_8_PROMPT §1 "Limits"), update merges into the stored campaign; the
 * service validates the merged result (combinations like the window ∩ the
 * account window, the dry-run mix summing to 100 %).
 */
const AudienceInput = z.strictObject({
  listIds: z.array(ObjectIdSchema).max(50).optional(),
  segmentId: ObjectIdSchema.nullable().optional(),
  filter: ContactFilterSchema.nullable().optional(),
  contactIds: z.array(ObjectIdSchema).max(CAMPAIGN_LIMITS.maxPickedContacts).optional(),
  excludeActiveCampaigns: z.boolean().optional(),
  skipIfMissing: z.array(z.string().regex(FIELD_KEY)).max(50).optional(),
});

const RecurrenceInput = z.strictObject({
  freq: z.enum(RECURRENCE_FREQS),
  days: z.array(int(0, 6)).max(7).default([]),
  time: z.string().regex(HHMM, 'Must be HH:mm (24 h)'),
  until: iso.nullable().default(null),
});

const ScheduleInput = z.strictObject({
  startAt: iso.nullable().optional(),
  endAt: iso.nullable().optional(),
  timezone: TimezoneSchema.optional(),
  recurrence: RecurrenceInput.nullable().optional(),
});

const RetryInput = z.strictObject({
  maxAttempts: int(CAMPAIGN_LIMITS.maxAttemptsMin, CAMPAIGN_LIMITS.maxAttemptsMax).optional(),
  intervalMinutes: int(
    CAMPAIGN_LIMITS.intervalMinMinutes,
    CAMPAIGN_LIMITS.intervalMaxMinutes,
  ).optional(),
  retryOn: z.array(z.enum(RETRY_ON)).max(RETRY_ON.length).optional(),
});

const FollowUpsInput = z.strictObject({
  callbacks: z.boolean().optional(),
  callbackMaxDays: int(1, CAMPAIGN_LIMITS.callbackMaxDaysMax).optional(),
  promiseCheck: z
    .strictObject({
      enabled: z.boolean().optional(),
      daysAfter: int(1, CAMPAIGN_LIMITS.promiseDaysAfterMax).optional(),
    })
    .optional(),
});

const PacingInput = z.strictObject({
  concurrency: int(1, 200).optional(),
  dialsPerMinute: int(1, CAMPAIGN_LIMITS.dialsPerMinuteMax).optional(),
  priority: z.enum(CAMPAIGN_PRIORITIES).optional(),
});

const MixInput = z.strictObject(
  Object.fromEntries(DRY_RUN_OUTCOMES.map((k) => [k, int(0, 10_000)])) as Record<
    (typeof DRY_RUN_OUTCOMES)[number],
    z.ZodNumber
  >,
);
const ScenariosInput = z.strictObject(
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, int(0, 100)])) as Record<
    (typeof SCENARIO_KEYS)[number],
    z.ZodNumber
  >,
);

const DryRunInput = z.strictObject({
  mix: MixInput.optional(),
  scenarios: ScenariosInput.optional(),
  speed: int(1, 100).optional(),
});

const settings = {
  audience: AudienceInput.optional(),
  schedule: ScheduleInput.optional(),
  window: CallingWindowInput.optional(),
  retry: RetryInput.optional(),
  followUps: FollowUpsInput.optional(),
  pacing: PacingInput.optional(),
  autoResume: z.boolean().optional(),
  dryRun: DryRunInput.nullable().optional(),
  chosenVersion: z.number().int().min(1).nullable().optional(),
  versionPolicy: z.enum(VERSION_POLICIES).optional(),
};

export const CreateCampaignBody = z.strictObject({
  name: z.string().trim().min(1).max(CAMPAIGN_LIMITS.nameMaxChars),
  mode: z.enum(CAMPAIGN_MODES).default('dry_run'),
  flowId: ObjectIdSchema,
  ...settings,
});

export const UpdateCampaignBody = z.strictObject({
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(CAMPAIGN_LIMITS.nameMaxChars).optional(),
  mode: z.enum(CAMPAIGN_MODES).optional(),
  flowId: ObjectIdSchema.optional(),
  ...settings,
});

export const CancelCampaignBody = z.strictObject({ hangUpLive: z.boolean().default(false) });

export const ExportCampaignBody = z.strictObject({ format: z.enum(EXPORT_FORMATS).default('csv') });

export const AudiencePreviewBody = z.strictObject({
  flowId: ObjectIdSchema,
  chosenVersion: z.number().int().min(1).nullable().optional(),
  audience: AudienceInput,
});

export const ListCampaignsQuery = z.strictObject({
  ...CursorQuerySchema.shape,
  status: z
    .union([z.enum(CAMPAIGN_STATUSES), z.array(z.enum(CAMPAIGN_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  mode: z.enum(CAMPAIGN_MODES).optional(),
  flowId: ObjectIdSchema.optional(),
  parentId: ObjectIdSchema.optional(),
  contactId: ObjectIdSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export const ListCampaignContactsQuery = z.strictObject({
  ...CursorQuerySchema.shape,
  status: z
    .union([z.enum(CAMPAIGN_CONTACT_STATUSES), z.array(z.enum(CAMPAIGN_CONTACT_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  lastResult: z.enum(CALL_RESULTS).optional(),
  disposition: z.enum(DISPOSITIONS).optional(),
  skipReason: z.enum(SKIP_REASONS).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

// ── responses ───────────────────────────────────────────────────────────────

const WindowSchema = z.object({ start: z.string(), end: z.string(), days: z.array(z.number()) });
const Ref = z.object({ id: z.string(), name: z.string() });

export const CampaignStatsSchema = z.object({
  total: z.number(),
  pending: z.number(),
  queued: z.number(),
  calling: z.number(),
  waiting: z.number(),
  completed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  canceled: z.number(),
  answered: z.number(),
  attempts: z.number(),
  dispositions: z.record(z.string(), z.number()),
  skippedBy: z.record(z.string(), z.number()),
  spentMicros: z.number(),
  virtualCostMicros: z.number(),
  failureStreak: z.number(),
});

export const CampaignListItemSchema = registry.register(
  'CampaignListItem',
  z.object({
    id: z.string(),
    name: z.string(),
    mode: z.enum(CAMPAIGN_MODES),
    status: z.enum(CAMPAIGN_STATUSES),
    pauseReason: z.enum(PAUSE_REASONS).nullable(),
    waitingUntil: z.string().nullable(),
    flow: z.object({ id: z.string(), name: z.string(), version: z.number().nullable() }),
    stats: CampaignStatsSchema,
    progressPct: z.number(),
    spentMicros: z.number(),
    virtualCostMicros: z.number(),
    nextRunAt: z.string().nullable(),
    parentId: z.string().nullable(),
    runNumber: z.number().nullable(),
    recurring: z.boolean(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
);

export const CampaignSchema = registry.register(
  'Campaign',
  CampaignListItemSchema.extend({
    revision: z.number(),
    chosenVersion: z.number().nullable(),
    versionPolicy: z.enum(VERSION_POLICIES),
    audience: z.object({
      listIds: z.array(z.string()),
      segmentId: z.string().nullable(),
      filter: z.record(z.string(), z.unknown()).nullable(),
      contactIds: z.array(z.string()),
      excludeActiveCampaigns: z.boolean(),
      skipIfMissing: z.array(z.string()),
    }),
    schedule: z.object({
      startAt: z.string().nullable(),
      endAt: z.string().nullable(),
      timezone: z.string(),
      recurrence: z
        .object({
          freq: z.enum(RECURRENCE_FREQS),
          days: z.array(z.number()),
          time: z.string(),
          until: z.string().nullable(),
        })
        .nullable(),
    }),
    window: WindowSchema,
    retry: z.object({
      maxAttempts: z.number(),
      intervalMinutes: z.number(),
      retryOn: z.array(z.enum(RETRY_ON)),
    }),
    followUps: z.object({
      callbacks: z.boolean(),
      callbackMaxDays: z.number(),
      promiseCheck: z.object({ enabled: z.boolean(), daysAfter: z.number() }),
    }),
    pacing: z.object({
      concurrency: z.number(),
      dialsPerMinute: z.number(),
      priority: z.enum(CAMPAIGN_PRIORITIES),
    }),
    autoResume: z.boolean(),
    dryRun: z
      .object({
        mix: z.record(z.string(), z.number()),
        scenarios: z.record(z.string(), z.number()),
        speed: z.number(),
      })
      .nullable(),
    estimate: z
      .object({
        contacts: z.number(),
        calls: z.number(),
        perCallMicros: z.number(),
        totalMicros: z.number(),
        minMicros: z.number(),
        maxMicros: z.number(),
        at: z.string(),
      })
      .nullable(),
    snapshot: z.object({ done: z.boolean(), counts: z.record(z.string(), z.number()) }),
    history: z.array(
      z.object({
        at: z.string(),
        status: z.enum(CAMPAIGN_STATUSES),
        pauseReason: z.enum(PAUSE_REASONS).nullable(),
        by: Ref.nullable(),
      }),
    ),
    error: z.object({ code: z.string() }).nullable(),
    createdBy: Ref.nullable(),
    startedBy: Ref.nullable(),
    canceledAt: z.string().nullable(),
    pausedAt: z.string().nullable(),
    walletAvailableMicros: z.number(),
  }),
);

export const CampaignContactRowSchema = registry.register(
  'CampaignContactRow',
  z.object({
    id: z.string(),
    contact: z.object({ id: z.string(), name: z.string().nullable() }),
    phoneLast4: z.string(),
    status: z.enum(CAMPAIGN_CONTACT_STATUSES),
    attempts: z.number(),
    lastResult: z.enum(CALL_RESULTS).nullable(),
    disposition: z.string().nullable(),
    promiseToPay: z.object({ date: z.string(), amountMicros: z.number().nullable() }).nullable(),
    callback: z.object({ date: z.string(), time: z.string().nullable() }).nullable(),
    skipReason: z.enum(SKIP_REASONS).nullable(),
    waitReason: z.enum(WAIT_REASONS).nullable().openapi({
      description: 'Why it waits for nextAttemptAt: window, daily_cap, weekly_cap or min_gap',
    }),
    nextAttemptAt: z.string().nullable(),
    lastCallId: z.string().nullable(),
    lastAttemptAt: z.string().nullable(),
    costMicros: z.number(),
  }),
);

export const AudiencePreviewSchema = registry.register(
  'AudiencePreview',
  z.object({
    total: z.number(),
    willCall: z.number(),
    tooMany: z.boolean(),
    excluded: z.record(z.string(), z.number()),
    missing: z.array(z.object({ field: z.string(), label: z.string(), count: z.number() })),
    samples: z.array(z.object({ name: z.string().nullable(), phoneLast4: z.string() })),
  }),
);

export const CampaignEstimateSchema = registry.register(
  'CampaignEstimate',
  z.object({
    contacts: z.number(),
    calls: z.number(),
    perCallMicros: z.number(),
    totalMicros: z.number(),
    minMicros: z.number(),
    maxMicros: z.number(),
    assumptions: z.object({
      avgDurationSec: z.number(),
      answerRateBps: z.number(),
      aiShareBps: z.number(),
      expectedAttempts: z.number(),
    }),
    walletAvailableMicros: z.number(),
  }),
);

// ── paths ───────────────────────────────────────────────────────────────────

const tags = ['Campaigns'];
const base = '/api/v1/campaigns';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const cursorPage = <T extends z.ZodType>(item: T, description: string) => ({
  description,
  content: {
    'application/json': {
      schema: z.object({
        success: z.literal(true),
        data: z.array(item),
        meta: CursorPageMetaSchema,
      }),
    },
  },
});
const common = { 401: errors[401], 403: errors[403], 404: errors[404] };
const writes = { ...common, 409: errors[409], 422: errors[422], 429: errors[429] };
const idempotencyHeader = z.object({
  'idempotency-key': z
    .string()
    .openapi({ description: 'Required — the same key replays the first answer' }),
});

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Campaigns of the account with stats (campaigns.read, cursor pagination)',
  security: bearer,
  request: { query: ListCampaignsQuery },
  responses: { 200: cursorPage(CampaignListItemSchema, 'Campaigns'), ...common, 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Create a draft (campaigns.write; ${String(CAMPAIGN_LIMITS.writesPerMinutePerUser)} writes / min / user)`,
  security: bearer,
  request: json(CreateCampaignBody),
  responses: { 201: ok(CampaignSchema), ...writes },
});
export const CampaignSummarySchema = registry.register(
  'CampaignSummary',
  z.object({
    running: z.number().int(),
    scheduled: z.number().int(),
    paused: z.number().int(),
    callsToday: z
      .number()
      .int()
      .openapi({ description: "Campaign calls since midnight in the account's time zone" }),
  }),
);
registry.registerPath({
  method: 'get',
  path: `${base}/summary`,
  tags,
  summary: 'Dashboard card: campaigns by live status and today’s campaign calls (campaigns.read)',
  security: bearer,
  responses: { 200: ok(CampaignSummarySchema), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/audience/preview`,
  tags,
  summary:
    'Audience counts, exclusions, samples (last 4 digits) and missing values (campaigns.read)',
  security: bearer,
  request: json(AudiencePreviewBody),
  responses: { 200: ok(AudiencePreviewSchema), ...common, 422: errors[422] },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}`,
  tags,
  summary: 'Campaign with stats, estimate and waiting info (campaigns.read)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 200: ok(CampaignSchema), ...common },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary:
    'Edit (campaigns.write) — per-status rules; a stale revision → 409 CAMPAIGN_REVISION_CONFLICT',
  security: bearer,
  request: { params: CampaignParams, ...json(UpdateCampaignBody) },
  responses: { 200: ok(CampaignSchema), ...writes },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary: 'Soft delete a draft / finished campaign (campaigns.write)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 204: noContentResponse, ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/duplicate`,
  tags,
  summary: 'Copy as a new draft (campaigns.write)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 201: ok(CampaignSchema), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/estimate`,
  tags,
  summary: 'Cost estimate for the current settings + wallet available (campaigns.read)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 200: ok(CampaignEstimateSchema), ...common, 409: errors[409], 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/start`,
  tags,
  summary:
    'Start now or schedule (campaigns.run, Idempotency-Key) — 409 CAMPAIGN_NOT_RUNNABLE, 429 CAMPAIGN_LIMIT_REACHED',
  security: bearer,
  request: { params: CampaignParams, headers: idempotencyHeader },
  responses: { 200: ok(CampaignSchema), ...writes },
});
for (const [action, summary] of [
  ['unschedule', 'Scheduled → draft (campaigns.run)'],
  ['pause', 'Pause (campaigns.run); live calls finish'],
  ['resume', 'Resume (campaigns.run) — refused while the pause cause holds'],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `${base}/{id}/${action}`,
    tags,
    summary,
    security: bearer,
    request: { params: CampaignParams },
    responses: { 200: ok(CampaignSchema), ...writes },
  });
}
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/cancel`,
  tags,
  summary: 'Cancel (campaigns.run); `hangUpLive` ends the live calls too',
  security: bearer,
  request: { params: CampaignParams, ...json(CancelCampaignBody) },
  responses: { 200: ok(CampaignSchema), ...writes },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/contacts`,
  tags,
  summary: 'Per-contact results (campaigns.read) — phones as the last 4 digits only',
  security: bearer,
  request: { params: CampaignParams, query: ListCampaignContactsQuery },
  responses: {
    200: cursorPage(CampaignContactRowSchema, 'Campaign contacts'),
    ...common,
    422: errors[422],
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/runs`,
  tags,
  summary: 'Runs of a recurring campaign, newest first (campaigns.read)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 200: ok(z.array(CampaignListItemSchema)), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/export`,
  tags,
  summary:
    'Results export (campaigns.export) — CSV / XLSX job; full phones only with contacts.export; download via GET /contact-exports/{id}',
  security: bearer,
  request: { params: CampaignParams, ...json(ExportCampaignBody) },
  responses: { 202: ok(ExportJobSchema, 'Queued'), ...writes },
});
