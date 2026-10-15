import { CALL_LIMITS, FLOW_LIMITS } from '../../config/limits';
import { CALL_EVENT_TYPES } from '../../db/models/call-event.model';
import { CALL_END_REASONS, CALL_PROVIDERS, CALL_STATUSES } from '../../db/models/call.model';
import { TRANSCRIPT_SOURCES, TRANSCRIPT_SPEAKERS } from '../../db/models/transcript-turn.model';
import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { CursorQuerySchema, ObjectIdSchema } from '../../shared/validation/schemas';

export const CallParams = z.strictObject({ id: ObjectIdSchema });

/** `POST /calls/web` — a browser test call of a flow (version) or an agent. */
export const StartWebCallBody = z
  .strictObject({
    flowId: ObjectIdSchema.optional(),
    version: z
      .union([z.literal('draft'), z.literal('published'), z.number().int().min(1)])
      .optional()
      .openapi({ description: 'Flows: `published` (default), `draft` or a version number' }),
    agentId: ObjectIdSchema.optional(),
    contactId: ObjectIdSchema.optional(),
    variables: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        z.string().max(FLOW_LIMITS.shortTextMaxChars),
      )
      .optional()
      .openapi({
        description: 'Typed values: contact fields (+ flow variables) — not with contactId',
      }),
    testPhone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'Use the +91… format')
      .optional()
      .openapi({ description: 'Only API steps / functions see it — never returned' }),
  })
  .superRefine((b, ctx) => {
    if (Boolean(b.flowId) === Boolean(b.agentId)) {
      ctx.addIssue({ code: 'custom', path: ['flowId'], message: 'Pick a flow or an agent' });
    }
    if (b.agentId && b.version !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['version'], message: 'Only for flows' });
    }
    if (b.contactId && (b.variables || b.testPhone)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contactId'],
        message: 'Use a contact or typed values, not both',
      });
    }
  });

const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

export const ListCallsQuery = z
  .strictObject({
    ...CursorQuerySchema.shape,
    limit: z.coerce.number().int().min(1).max(CALL_LIMITS.callsPageMax).default(50),
    status: csvOf(CALL_STATUSES).optional().openapi({ description: 'Comma-separated statuses' }),
    flowId: ObjectIdSchema.optional(),
    agentId: ObjectIdSchema.optional(),
    contactId: ObjectIdSchema.optional(),
    isTest: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(80).optional().openapi({ description: 'Contact name' }),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: 'from must be before to',
    path: ['to'],
  });

// ── Responses ───────────────────────────────────────────────────────────────

const money = z.number().int();

export const CallSchema = registry.register(
  'Call',
  z.object({
    id: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    provider: z.enum(CALL_PROVIDERS),
    isTest: z.boolean(),
    status: z.enum(CALL_STATUSES),
    endReason: z.enum(CALL_END_REASONS).nullable(),
    source: z.object({
      kind: z.enum(['flow', 'agent']),
      flowId: z.string().nullable(),
      flowVersionRef: z.union([z.literal('draft'), z.number()]).nullable(),
      agentId: z.string().nullable(),
      name: z.string().nullable().openapi({ description: 'Flow / agent name (null when deleted)' }),
    }),
    contact: z.object({ id: z.string(), name: z.string() }).nullable(),
    startedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    timestamps: z.object({
      queuedAt: z.string(),
      ringingAt: z.string().nullable(),
      answeredAt: z.string().nullable(),
      endedAt: z.string().nullable(),
    }),
    durationSec: z.number(),
    variables: z.record(z.string(), z.string()),
    outcome: z.record(z.string(), z.unknown()),
    disposition: z.string().nullable(),
    languageDetected: z.string().nullable(),
    metrics: z.object({
      latency: z.object({
        p50Ms: z.number().nullable(),
        p95Ms: z.number().nullable(),
        maxMs: z.number().nullable(),
        samples: z.number(),
      }),
      bargeIns: z.number(),
      silencePrompts: z.number(),
      aiSeconds: z.number(),
      ttsChars: z.number(),
      ttsCachedChars: z.number(),
    }),
    cost: z.object({
      telephonyMicros: money,
      aiMicros: money,
      ttsMicros: money,
      commissionMicros: money,
      totalMicros: money,
    }),
    recording: z.object({ durationSec: z.number(), sizeBytes: z.number() }).nullable(),
    flowRunId: z.string().nullable(),
    error: z.object({ code: z.string() }).nullable(),
    createdAt: z.string(),
  }),
);

export const StartedWebCallSchema = registry.register(
  'StartedWebCall',
  z.object({
    call: CallSchema,
    mediaTicket: z.string().openapi({ description: 'One-time ticket for /ws/media (60 s)' }),
    expiresAt: z.string(),
    wsPath: z.string(),
    textInput: z.boolean().openapi({ description: 'call.say_text allowed (dev / tests)' }),
  }),
);

export const TranscriptTurnSchema = registry.register(
  'CallTranscriptTurn',
  z.object({
    seq: z.number(),
    speaker: z.enum(TRANSCRIPT_SPEAKERS),
    text: z.string(),
    language: z.string().nullable(),
    startMs: z.number(),
    endMs: z.number(),
    interrupted: z.boolean(),
    source: z.enum(TRANSCRIPT_SOURCES),
  }),
);

export const CallEventSchema = registry.register(
  'CallEvent',
  z.object({
    seq: z.number(),
    type: z.enum(CALL_EVENT_TYPES),
    data: z.record(z.string(), z.unknown()),
    at: z.string(),
  }),
);

export const RecordingLinkSchema = registry.register(
  'CallRecordingLink',
  z.object({ url: z.string(), expiresAt: z.string(), durationSec: z.number() }),
);

// ── OpenAPI paths ───────────────────────────────────────────────────────────

const tags = ['Calls'];
const read = { 401: errors[401], 403: errors[403], 404: errors[404] };
const base = '/api/v1/calls';

registry.registerPath({
  method: 'post',
  path: `${base}/web`,
  tags,
  summary: `Start a browser test call of a flow or an agent (calls.trigger + flows.read / agents.read; ${String(CALL_LIMITS.webCallsPerMinutePerUser)} / min / user; wallet hold taken here; 429 CALL_LIMIT_REACHED, 503 CALL_CAPACITY, 422 FLOW_INVALID / WALLET_INSUFFICIENT_BALANCE)`,
  security: bearer,
  request: { body: { content: { 'application/json': { schema: StartWebCallBody } } } },
  responses: {
    201: ok(StartedWebCallSchema, 'Call created — connect to /ws/media with the ticket'),
    ...read,
    422: errors[422],
    429: errors[429],
    503: { description: 'This server is at its call capacity (CALL_CAPACITY)' },
  },
});
registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Calls of the account, newest first (calls.read, cursor pagination)',
  security: bearer,
  request: { query: ListCallsQuery },
  responses: {
    200: {
      description: 'Calls',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(CallSchema),
            meta: CursorPageMetaSchema,
          }),
        },
      },
    },
    401: errors[401],
    403: errors[403],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/active`,
  tags,
  summary: 'Live calls of the account (calls.read)',
  security: bearer,
  responses: { 200: ok(z.array(CallSchema)), 401: errors[401], 403: errors[403] },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}`,
  tags,
  summary: 'One call: outcome, metrics, cost (calls.read)',
  security: bearer,
  request: { params: CallParams },
  responses: { 200: ok(CallSchema), ...read },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/transcript`,
  tags,
  summary: `Final transcript turns (calls.read; up to ${String(CALL_LIMITS.transcriptListedMax)})`,
  security: bearer,
  request: { params: CallParams },
  responses: { 200: ok(z.array(TranscriptTurnSchema)), ...read },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/events`,
  tags,
  summary: `Timeline events (calls.read; up to ${String(CALL_LIMITS.eventsListedMax)}; never texts, digits or phones)`,
  security: bearer,
  request: { params: CallParams },
  responses: { 200: ok(z.array(CallEventSchema)), ...read },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/recording`,
  tags,
  summary: `Signed recording link, ${String(CALL_LIMITS.recordingUrlTtlSec / 60)} min (calls.listen; audited; 404 when the call has none)`,
  security: bearer,
  request: { params: CallParams },
  responses: { 200: ok(RecordingLinkSchema), ...read },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/hangup`,
  tags,
  summary: 'Hang up a live call from another tab (calls.trigger; 409 CALL_NOT_ACTIVE)',
  security: bearer,
  request: { params: CallParams },
  responses: { 200: ok(CallSchema), ...read, 409: errors[409] },
});
