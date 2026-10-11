import { FLOW_LIMITS } from '../../config/limits';
import {
  RUN_END_REASONS,
  RUN_MODES,
  RUN_STATUSES,
  WAITING_KINDS,
} from '../../db/models/flow-run.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { FlowParams } from './flows.schema';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const RunParams = z.strictObject({ id: ObjectIdSchema, runId: ObjectIdSchema });

export const StartSimulationBody = z
  .strictObject({
    version: z
      .union([z.literal('draft'), z.literal('published'), z.number().int().min(1)])
      .default('draft')
      .openapi({ description: '`draft` (default), `published` or a version number' }),
    contactId: ObjectIdSchema.optional(),
    variables: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        z.string().max(FLOW_LIMITS.shortTextMaxChars),
      )
      .optional()
      .openapi({
        description: 'Manual values: contact fields and flow variables (not with contactId)',
      }),
    testPhone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'Use the +91… format')
      .optional()
      .openapi({
        description: 'Only `{{contact.phone}}` in API requests sees it — never returned',
      }),
  })
  .superRefine((b, ctx) => {
    if (b.contactId && (b.variables || b.testPhone)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contactId'],
        message: 'Use a contact or manual values, not both',
      });
    }
  });

export const SimulationInputBody = z
  .strictObject({
    clientInputId: z.string().uuid(),
    kind: z.enum(['dtmf', 'speech', 'no_input', 'transfer_result', 'hangup']),
    value: z.string().max(500).optional(),
  })
  .superRefine((b, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message });
    if (b.kind === 'dtmf' && !/^[0-9*#]{1,20}$/.test(b.value ?? '')) bad('Keys 0–9, * or # (1–20)');
    if (b.kind === 'speech' && !(b.value ?? '').trim()) bad('Required');
    if (
      b.kind === 'transfer_result' &&
      !['connected', 'failed', 'no_answer'].includes(b.value ?? '')
    ) {
      bad('connected, failed or no_answer');
    }
  });

export const ListSimulationsQuery = z.strictObject({
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const StatsQuery = z
  .strictObject({
    version: z.union([z.literal('draft'), z.coerce.number().int().min(1)]).default('draft'),
    mode: z.enum(RUN_MODES).default('simulator'),
    from: ymd.optional(),
    to: ymd.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['from'],
    message: 'Must be before "to"',
  });

// ── Responses ───────────────────────────────────────────────────────────────

export const TranscriptEntrySchema = registry.register(
  'FlowTranscriptEntry',
  z.object({
    seq: z.number(),
    role: z.enum(['bot', 'customer', 'system']),
    kind: z.enum(['say', 'play', 'dtmf', 'speech', 'ai', 'message', 'transfer', 'note']),
    text: z.string(),
    nodeId: z.string().nullable(),
    at: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
);

const WaitingSchema = z
  .object({
    kind: z.enum(WAITING_KINDS),
    nodeId: z.string(),
    timeoutSec: z.number().optional(),
    keys: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
    mode: z.enum(['menu', 'digits']).optional(),
    maxDigits: z.number().optional(),
    finishKey: z.enum(['#', 'none']).optional(),
    seconds: z.number().optional(),
    transferPhoneLast4: z.string().optional(),
  })
  .nullable();

export const FlowRunSchema = registry.register(
  'FlowRun',
  z.object({
    id: z.string(),
    flowId: z.string(),
    versionRef: z.union([z.literal('draft'), z.number()]),
    status: z.enum(RUN_STATUSES),
    waiting: WaitingSchema,
    currentNodeId: z.string().nullable(),
    variables: z.record(z.string(), z.string()),
    outcome: z.object({
      disposition: z.string().nullable(),
      dispositionNote: z.string().nullable(),
      promiseToPay: z.object({ date: z.string(), amountMicros: z.number().nullable() }).nullable(),
      callback: z.object({ date: z.string(), time: z.string().nullable() }).nullable(),
      transfer: z.object({ result: z.string() }).nullable(),
      messages: z.array(
        z.object({
          channel: z.enum(['sms', 'whatsapp']),
          nodeId: z.string(),
          text: z.string().nullable(),
          templateName: z.string().nullable(),
          params: z.array(z.string()),
        }),
      ),
    }),
    costMicros: z.number(),
    endReason: z.enum(RUN_END_REASONS).nullable(),
    contactName: z.string().nullable(),
    createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
    transcript: z.array(TranscriptEntrySchema).optional(),
    trace: z
      .array(
        z.object({
          seq: z.number(),
          at: z.string(),
          nodeId: z.string().nullable(),
          type: z.string().nullable(),
          event: z.string(),
          handle: z.string().optional(),
          durationMs: z.number().optional(),
          detail: z.string().optional(),
        }),
      )
      .optional(),
  }),
);

export const SimulationStepSchema = registry.register(
  'FlowSimulationStep',
  z.object({
    run: FlowRunSchema,
    added: z.array(TranscriptEntrySchema),
    replay: z.boolean(),
  }),
);

export const FlowRunSummarySchema = registry.register(
  'FlowRunSummary',
  z.object({
    id: z.string(),
    versionRef: z.union([z.literal('draft'), z.number()]),
    status: z.enum(RUN_STATUSES),
    endReason: z.enum(RUN_END_REASONS).nullable(),
    disposition: z.string().nullable(),
    costMicros: z.number(),
    contactName: z.string().nullable(),
    createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdAt: z.string(),
  }),
);

export const NodeStatSchema = registry.register(
  'FlowNodeStat',
  z.object({
    nodeId: z.string(),
    entered: z.number(),
    exits: z.record(z.string(), z.number()),
    errors: z.number(),
    avgMs: z.number(),
  }),
);

// ── OpenAPI paths ───────────────────────────────────────────────────────────

const tags = ['Call flows'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const read = { 401: errors[401], 403: errors[403], 404: errors[404] };
const write = { ...read, 409: errors[409], 422: errors[422], 429: errors[429] };
const base = '/api/v1/flows/{id}/simulations';

registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Start a text simulation of the draft / published / a version (flows.write; ${String(FLOW_LIMITS.simulatorInputsPerMinute)} / min / user; a draft with errors → 422 FLOW_INVALID; AI turns are billed)`,
  security: bearer,
  request: { params: FlowParams, ...json(StartSimulationBody) },
  responses: { 201: ok(SimulationStepSchema, 'Started'), ...write },
});
registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: `Latest ${String(FLOW_LIMITS.simulationsListed)} simulations of the flow (everyone's; mine=true → own only)`,
  security: bearer,
  request: { params: FlowParams, query: ListSimulationsQuery },
  responses: { 200: ok(z.array(FlowRunSummarySchema)), ...read },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{runId}`,
  tags,
  summary: 'One simulation with its transcript and trace',
  security: bearer,
  request: { params: RunParams },
  responses: { 200: ok(FlowRunSchema), ...read },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{runId}/inputs`,
  tags,
  summary:
    'Send what the customer does (keys, words, silence, transfer result, hang up) — idempotent by clientInputId; 422 when the run waits for something else; 409 when it ended',
  security: bearer,
  request: { params: RunParams, ...json(SimulationInputBody) },
  responses: { 200: ok(SimulationStepSchema), ...write },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/flows/{id}/stats',
  tags,
  summary:
    'Per-node counters for a version and date range (account timezone; default last 7 days, simulator runs)',
  security: bearer,
  request: { params: FlowParams, query: StatsQuery },
  responses: { 200: ok(z.array(NodeStatSchema)), ...read, 422: errors[422] },
});
