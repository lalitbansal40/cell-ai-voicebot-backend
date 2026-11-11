import { CAMPAIGN_LIMITS } from '../../config/limits';
import { VOICE_API_RETRY_INTERVALS } from '../../core/voice-api/types';
import { DISPOSITIONS } from '../../db/models/ai-agent.model';
import {
  CALL_RESULTS,
  CAMPAIGN_CONTACT_STATUSES,
  WAIT_REASONS,
} from '../../db/models/campaign-contact.model';
import {
  CAMPAIGN_AMD_MODES,
  CAMPAIGN_LINES,
  TALK_MODES,
  TEAM_LIMITS,
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
  VOICE_BATCH_STATES,
} from '../../db/models/campaign.model';
import { EXPORT_FORMATS } from '../../db/models/export-job.model';
import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import {
  bearer,
  bearerOrKey,
  errors,
  noContentResponse,
  ok,
  PUBLIC_API_TAG,
} from '../../shared/openapi/responses';
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

export const RecurrenceInput = z.strictObject({
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

const PhoneLineInput = z.strictObject({
  callerNumberId: ObjectIdSchema.nullable().optional(),
  amd: z.enum(CAMPAIGN_AMD_MODES).optional(),
  voicemailText: z.string().trim().min(1).max(500).nullable().optional(),
});

const ProgramInput = z.strictObject({ kind: z.enum(['flow', 'agent']), id: ObjectIdSchema });

/** VAPI: recorded voice (account audio) or an assigned Cell24x7 IVR. */
const VoiceContentInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('audio'), flowAudioId: ObjectIdSchema }),
  z.strictObject({ kind: z.literal('ivr'), ivrId: z.number().int().positive().max(2_147_483_647) }),
]);
const VoiceApiInput = z.strictObject({
  content: VoiceContentInput.nullable().optional(),
  retries: int(0, 3).optional(),
  retryIntervalMin: z
    .union(
      VOICE_API_RETRY_INTERVALS.map((m) => z.literal(m)) as unknown as [
        z.ZodLiteral<5>,
        z.ZodLiteral<10>,
        z.ZodLiteral<30>,
        z.ZodLiteral<60>,
        z.ZodLiteral<180>,
        z.ZodLiteral<300>,
      ],
    )
    .optional(),
});
/** CM: team calling — who may join, and the pause after each call. */
export const TeamInput = z.strictObject({
  agentUserIds: z.array(ObjectIdSchema).max(TEAM_LIMITS.agentsMax).nullable().default(null),
  wrapUpSec: z
    .number()
    .int()
    .min(0)
    .max(TEAM_LIMITS.wrapUpMaxSec)
    .default(TEAM_LIMITS.wrapUpDefaultSec),
});

const settings = {
  line: z.enum(CAMPAIGN_LINES).optional(),
  /** CM: who talks — `ai` (flow / agent) or `team` (members in the browser; live only). */
  talkMode: z.enum(TALK_MODES).optional().openapi({
    description:
      '`ai` (default): a flow or AI agent talks. `team`: team members take the calls in the browser (live phone / WhatsApp call campaigns; no flow)',
  }),
  team: TeamInput.nullable().optional(),
  voiceApi: VoiceApiInput.nullable().optional(),
  channelId: ObjectIdSchema.nullable().optional(),
  program: ProgramInput.nullable().optional(),
  askPermissionFirst: z.strictObject({ templateId: ObjectIdSchema }).nullable().optional(),
  audience: AudienceInput.optional(),
  phoneLine: PhoneLineInput.optional(),
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
  flowId: ObjectIdSchema.optional(),
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
  talkMode: z.enum(TALK_MODES).optional(),
  channelId: ObjectIdSchema.nullable().optional(),
  askPermissionFirst: z.boolean().optional(),
  line: z.enum(CAMPAIGN_LINES).optional(),
  program: ProgramInput.nullable().optional(),
  flowId: ObjectIdSchema.optional(),
  chosenVersion: z.number().int().min(1).nullable().optional(),
  audience: AudienceInput,
});

export const ListCampaignsQuery = z.strictObject({
  /** `phone` lists SIP / test-line and recorded-voice campaigns (the SIP / Normal call tab). */
  line: z.enum(CAMPAIGN_LINES).optional(),
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
    line: z.enum(CAMPAIGN_LINES).optional(),
    /** VAPI: what a recorded-voice campaign plays (list label). */
    voice: z
      .object({ kind: z.enum(['audio', 'ivr']), name: z.string() })
      .nullable()
      .optional(),
    channelId: z.string().nullable().optional(),
    program: ProgramInput.extend({ name: z.string().optional() }).nullable().optional(),
    /** CM: who talks on the calls. */
    talkMode: z.enum(TALK_MODES).optional(),
    team: z
      .object({ agentUserIds: z.array(z.string()).nullable(), wrapUpSec: z.number() })
      .nullable()
      .optional(),
    askPermissionFirst: z.object({ templateId: z.string() }).nullable().optional(),
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
    phoneLine: z.object({
      callerNumberId: z.string().nullable(),
      amd: z.enum(CAMPAIGN_AMD_MODES),
      voicemailText: z.string().nullable(),
    }),
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
    voiceApi: z
      .object({
        content: z
          .object({
            kind: z.enum(['audio', 'ivr']),
            flowAudioId: z.string().nullable(),
            ivrId: z.number().int().nullable(),
            name: z.string(),
          })
          .nullable(),
        audioSec: z.number(),
        retries: z.number().int(),
        retryIntervalMin: z.number().int(),
        batches: z.array(
          z.object({
            no: z.number().int(),
            state: z.enum(VOICE_BATCH_STATES),
            requestId: z.string().nullable(),
            count: z.number().int(),
            amountMicros: z.number(),
            createdAt: z.string(),
            submittedAt: z.string().nullable(),
            doneAt: z.string().nullable(),
            error: z.string().nullable(),
          }),
        ),
        lastError: z.object({ code: z.string(), at: z.string() }).nullable(),
      })
      .nullable()
      .optional()
      .openapi({ description: 'VAPI: recorded-voice / IVR settings and Cell24x7 batches' }),
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
    /** VAPI: Cell24x7's view of this number. */
    voice: z
      .object({
        batchNo: z.number().int(),
        providerStatus: z.string().nullable(),
        durationSec: z.number(),
        retryCount: z.number().int(),
        dtmf: z.string().nullable(),
        ivrDisposition: z.string().nullable(),
      })
      .nullable()
      .optional(),
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
    transportNote: z.string().optional(),
    /** VAPI: per-number price of a recorded-voice campaign (charged at submit). */
    voice: z
      .object({
        pulsesPerNumber: z.number().int(),
        perNumberMicros: z.number(),
        notPriced: z.boolean(),
        notIndianMobile: z.number().int(),
        etaSec: z.number().int(),
      })
      .optional(),
  }),
);

// ── paths ───────────────────────────────────────────────────────────────────

const tags = ['Campaigns'];
const publicTags = [...tags, PUBLIC_API_TAG];
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
  tags: publicTags,
  summary: 'Campaigns of the account with stats (campaigns.read, cursor pagination)',
  security: bearerOrKey,
  request: { query: ListCampaignsQuery },
  responses: { 200: cursorPage(CampaignListItemSchema, 'Campaigns'), ...common, 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags: publicTags,
  summary: `Create a draft (campaigns.write; ${String(CAMPAIGN_LIMITS.writesPerMinutePerUser)} writes / min / user)`,
  security: bearerOrKey,
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
  tags: publicTags,
  summary: 'Campaign with stats, estimate and waiting info (campaigns.read)',
  security: bearerOrKey,
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
  tags: publicTags,
  summary: 'Cost estimate for the current settings + wallet available (campaigns.read)',
  security: bearerOrKey,
  request: { params: CampaignParams },
  responses: { 200: ok(CampaignEstimateSchema), ...common, 409: errors[409], 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/start`,
  tags: publicTags,
  summary:
    'Start now or schedule (campaigns.run, Idempotency-Key) — 409 CAMPAIGN_NOT_RUNNABLE, 429 CAMPAIGN_LIMIT_REACHED',
  security: bearerOrKey,
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
    tags: action === 'unschedule' ? tags : publicTags,
    summary,
    security: action === 'unschedule' ? bearer : bearerOrKey,
    request: { params: CampaignParams },
    responses: { 200: ok(CampaignSchema), ...writes },
  });
}
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/cancel`,
  tags: publicTags,
  summary: 'Cancel (campaigns.run); `hangUpLive` ends the live calls too',
  security: bearerOrKey,
  request: { params: CampaignParams, ...json(CancelCampaignBody) },
  responses: { 200: ok(CampaignSchema), ...writes },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/contacts`,
  tags: publicTags,
  summary: 'Per-contact results (campaigns.read) — phones as the last 4 digits only',
  security: bearerOrKey,
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
  tags: publicTags,
  summary: 'Runs of a recurring campaign, newest first (campaigns.read)',
  security: bearerOrKey,
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

// CM — team calling: the agents' calling session of a team campaign (browser only)
export const TeamCallParams = z.strictObject({ id: ObjectIdSchema, callId: ObjectIdSchema });
export const TeamWrapUpBody = z.strictObject({
  disposition: z.string().trim().max(64).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});
const AGENT_VIEW_STATES = ['ready', 'on_call', 'wrap_up', 'paused', 'away'] as const;
export const TeamSessionSchema = registry.register(
  'CampaignTeamSession',
  z.object({
    agents: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        state: z.enum(AGENT_VIEW_STATES),
        callId: z.string().nullable(),
        since: z.string().datetime(),
        wrapUpUntil: z.string().datetime().nullable(),
      }),
    ),
    ready: z.number().int(),
    onCall: z.number().int(),
  }),
);
export const TeamNextSchema = registry.register(
  'CampaignTeamNext',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('call'),
      callId: z.string(),
      transport: z.enum(['sip', 'whatsapp']),
      contact: z.object({ id: z.string(), name: z.string().nullable() }),
      mediaTicket: z.string(),
      expiresAt: z.string(),
      wsPath: z.string(),
    }),
    z.object({
      kind: z.literal('wait'),
      reason: z.enum(['not_running', 'window', 'wallet', 'no_contacts', 'line', 'busy']),
      until: z.string().datetime().nullable(),
    }),
  ]),
);
export const TeamWrapUpSchema = registry.register(
  'CampaignTeamWrapUp',
  z.object({ callId: z.string(), disposition: z.string().nullable() }),
);
for (const action of ['join', 'leave', 'heartbeat', 'pause', 'ready'] as const)
  registry.registerPath({
    method: 'post',
    path: `${base}/{id}/session/${action}`,
    tags,
    summary: {
      join: 'Join the calling session of a team campaign (calls.trigger) — 403 AGENT_NOT_IN_CAMPAIGN',
      leave: 'Leave the calling session (calls.trigger)',
      heartbeat: 'Still here (every 10 s; 30 s silent = away, no calls) — 409 AGENT_SESSION_GONE',
      pause: 'Take a break: no calls until ready (calls.trigger)',
      ready: 'Back from a break or wrap-up (calls.trigger)',
    }[action],
    security: bearer,
    request: { params: CampaignParams },
    responses: { 200: ok(TeamSessionSchema), ...writes },
  });
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/session`,
  tags,
  summary: 'Who is calling for this team campaign and what each agent is doing (campaigns.read)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 200: ok(TeamSessionSchema), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/session/next`,
  tags,
  summary:
    "The agent's next call: a human call to the next dialable contact with a media ticket, or why to wait (calls.trigger) — 409 AGENT_CALL_ACTIVE / AGENT_SESSION_GONE",
  security: bearer,
  request: { params: CampaignParams },
  responses: { 200: ok(TeamNextSchema), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/calls/{callId}/wrap-up`,
  tags,
  summary:
    "Save the outcome and a note of the agent's finished call; the agent is ready again (calls.trigger) — 422 DISPOSITION_UNKNOWN",
  security: bearer,
  request: { params: TeamCallParams, ...json(TeamWrapUpBody) },
  responses: { 200: ok(TeamWrapUpSchema), ...writes },
});
export const CampaignAgentStatsSchema = registry.register(
  'CampaignAgentStats',
  z.object({
    userId: z.string().nullable().openapi({ description: 'null = calls the AI talked on' }),
    name: z.string(),
    calls: z.number().int(),
    connected: z.number().int(),
    talkSec: z.number().int(),
    outcomes: z.record(z.string(), z.number().int()),
  }),
);
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/agents`,
  tags,
  summary:
    'Who talked on the campaign: per member (and the AI) calls, connected, talk time, outcomes (campaigns.read)',
  security: bearer,
  request: { params: CampaignParams },
  responses: { 200: ok(z.array(CampaignAgentStatsSchema)), ...common },
});
