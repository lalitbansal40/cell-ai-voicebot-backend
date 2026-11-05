import { WA_RECIPIENT_STATUSES } from '../../db/models/whatsapp-campaign-recipient.model';
import {
  WA_CAMPAIGN_PAUSE_REASONS,
  WA_CAMPAIGN_STATUSES,
  WA_VARIABLE_KINDS,
} from '../../db/models/whatsapp-campaign.model';
import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import {
  errors,
  noContentResponse,
  ok,
  okWith,
  publicErrors,
  publicOp,
} from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { TimezoneSchema } from '../auth/auth.schema';
import { RecurrenceInput } from '../campaigns/campaigns.schema';

export const CampaignIdParams = z.strictObject({ id: ObjectIdSchema });
export const ListCampaignsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  status: z.enum(WA_CAMPAIGN_STATUSES).optional(),
});
export const RecipientsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  status: z.enum(WA_RECIPIENT_STATUSES).optional(),
});
const HeaderLocation = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().max(100).optional(),
  address: z.string().max(200).optional(),
});
export const CampaignBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  headerMediaToken: ObjectIdSchema.nullable().optional(),
  headerLocation: HeaderLocation.nullable().optional(),
  channelId: ObjectIdSchema,
  variants: z
    .array(
      z.strictObject({
        key: z.enum(['A', 'B', 'C']),
        templateId: ObjectIdSchema,
        splitPct: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(3),
  abWinner: z
    .strictObject({
      metric: z.enum(['read', 'reply']),
      afterHours: z.number().int().min(1).max(72),
    })
    .nullable()
    .optional(),
  variables: z
    .record(
      z.string().max(60),
      z.strictObject({
        kind: z.enum(WA_VARIABLE_KINDS),
        value: z.string().max(1024).nullable().optional(),
      }),
    )
    .optional(),
  audience: z
    .strictObject({
      listIds: z.array(ObjectIdSchema).max(50).optional(),
      segmentId: ObjectIdSchema.nullable().optional(),
      tags: z
        .strictObject({
          values: z.array(z.string().trim().min(1).max(50)).max(50),
          mode: z.enum(['any', 'all']),
        })
        .nullable()
        .optional(),
      contactIds: z.array(ObjectIdSchema).max(5_000).optional(),
      csvUploadId: ObjectIdSchema.nullable().optional(),
    })
    .refine(
      (a) =>
        Boolean(
          a.listIds?.length ||
          a.segmentId ||
          a.tags?.values.length ||
          a.contactIds?.length ||
          a.csvUploadId,
        ),
      { message: 'Pick who gets the message' },
    ),
  excludeRecentDays: z.number().int().min(0).max(90).optional(),
  schedule: z
    .strictObject({
      kind: z.enum(['now', 'at', 'recurring']),
      at: z.iso.datetime({ offset: true }).nullable().optional(),
      timezone: TimezoneSchema.optional(),
      recurrence: RecurrenceInput.nullable().optional(),
    })
    .optional(),
});

const Counters = z.object({
  total: z.number(),
  queued: z.number(),
  sent: z.number(),
  delivered: z.number(),
  read: z.number(),
  replied: z.number(),
  failedTotal: z.number(),
  skippedTotal: z.number(),
  skipped: z.record(z.string(), z.number()),
  failed: z.record(z.string(), z.number()),
});
export const WaCampaignSchema = registry.register(
  'WhatsAppCampaign',
  z.object({
    id: z.string(),
    name: z.string(),
    channelId: z.string(),
    status: z.enum(WA_CAMPAIGN_STATUSES),
    pauseReason: z.enum(WA_CAMPAIGN_PAUSE_REASONS).nullable(),
    variants: z.array(
      z.object({ key: z.enum(['A', 'B', 'C']), templateId: z.string(), splitPct: z.number() }),
    ),
    abWinner: z
      .object({
        metric: z.enum(['read', 'reply']),
        afterHours: z.number(),
        decidedAt: z.string().nullable(),
        winner: z.enum(['A', 'B', 'C']).nullable(),
      })
      .nullable(),
    variables: z.record(
      z.string(),
      z.object({ kind: z.enum(WA_VARIABLE_KINDS), value: z.string().nullable() }),
    ),
    audience: z.object({
      listIds: z.array(z.string()),
      segmentId: z.string().nullable(),
      tags: z.object({ values: z.array(z.string()), mode: z.enum(['any', 'all']) }).nullable(),
      contactIds: z.array(z.string()),
      csvUploadId: z.string().nullable(),
    }),
    excludeRecentDays: z.number(),
    schedule: z.object({
      kind: z.enum(['now', 'at', 'recurring']),
      at: z.string().nullable(),
      timezone: z.string(),
      recurrence: RecurrenceInput.nullable(),
    }),
    parentCampaignId: z.string().nullable(),
    recurrenceEnabled: z.boolean(),
    headerLocation: HeaderLocation.nullable().optional(),
    headerMedia: z
      .object({
        kind: z.string(),
        fileName: z.string().nullable(),
        mimeType: z.string(),
        size: z.number(),
      })
      .nullable(),
    counters: Counters,
    cost: z.object({ estimateMicros: z.number(), chargedMicros: z.number() }),
    nextBatchAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
const EstimateSchema = registry.register(
  'WhatsAppCampaignEstimate',
  z.object({
    recipients: z.number(),
    skipped: z.record(z.string(), z.number()),
    shortfallMicros: z.number(),
    byMarket: z.array(
      z.object({
        market: z.string(),
        category: z.string(),
        count: z.number(),
        priceMicros: z.number(),
      }),
    ),
    totalMicros: z.number(),
    walletAvailableMicros: z.number(),
    enough: z.boolean(),
    note: z.string(),
  }),
);
const RecipientSchema = registry.register(
  'WhatsAppCampaignRecipient',
  z.object({
    contactId: z.string(),
    name: z.string().nullable(),
    phone: z.string().nullable().openapi({ description: 'Masked' }),
    variant: z.enum(['A', 'B', 'C']),
    status: z.enum(WA_RECIPIENT_STATUSES),
    skipReason: z.string().nullable(),
    errorCode: z.number().nullable(),
    sentAt: z.string().nullable(),
    repliedAt: z.string().nullable(),
  }),
);
const ReportSchema = registry.register(
  'WhatsAppCampaignReport',
  z.object({
    funnel: z.object({
      total: z.number(),
      skipped: z.number(),
      sent: z.number(),
      delivered: z.number(),
      read: z.number(),
      replied: z.number(),
      failed: z.number(),
    }),
    cost: z.object({ estimateMicros: z.number(), chargedMicros: z.number() }),
    skippedByReason: z.record(z.string(), z.number()),
    failedByCode: z.record(z.string(), z.number()),
    perDay: z.array(z.object({ day: z.string(), sent: z.number() })),
    variants: z.array(
      z.object({ key: z.string(), sent: z.number(), read: z.number(), replied: z.number() }),
    ),
    winner: z.enum(['A', 'B', 'C']).nullable(),
  }),
);

const json = <T extends z.ZodType>(schema: T, example: unknown) => ({
  body: { content: { 'application/json': { schema, example } } },
});
type Extra = Pick<Parameters<typeof registry.registerPath>[0], 'request' | 'responses'>;
const AREA = 'WhatsApp bulk campaigns';
const READ = 'whatsapp-campaigns:read';
const WRITE = 'whatsapp-campaigns:write';
/** Every route is public (DOCS-T3): session permission or key scope (`access()`). */
const path = (
  method: 'get' | 'post' | 'patch' | 'delete',
  p: string,
  op: { operationId: string; scope: string; summary: string; description: string },
  extra: Extra,
) =>
  registry.registerPath({
    method,
    path: `/api/v1/whatsapp-campaigns${p}`,
    ...publicOp({ ...op, area: AREA }),
    ...extra,
  });
const page = <T extends z.ZodType>(item: T, example: unknown) => ({
  description: 'OK',
  content: {
    'application/json': {
      schema: z.object({
        success: z.literal(true),
        data: z.array(item),
        meta: OffsetPageMetaSchema,
      }),
      example: { success: true, data: [example], meta: { page: 1, limit: 25, total: 1 } },
    },
  },
});
const ID = '6720f0a1b2c3d4e5f6a7b8c9';
const CHANNEL = '6720f0a1b2c3d4e5f6a7b8d1';
const TEMPLATE = '6720f0a1b2c3d4e5f6a7b8d2';
const LIST = '6720f0a1b2c3d4e5f6a7b8d3';
const AT = '2026-11-05T09:30:00.000Z';
const BODY_EXAMPLE = {
  name: 'November EMI reminder',
  channelId: CHANNEL,
  variants: [{ key: 'A', templateId: TEMPLATE, splitPct: 100 }],
  variables: {
    '1': { kind: 'contact.name' },
    '2': { kind: 'field', value: 'amount_due' },
    '3': { kind: 'static', value: 'NotifyNow Finance' },
  },
  audience: { listIds: [LIST] },
  excludeRecentDays: 3,
  schedule: { kind: 'at', at: '2026-11-06T04:30:00.000Z', timezone: 'Asia/Kolkata' },
};
const COUNTERS = {
  total: 1250,
  queued: 0,
  sent: 1200,
  delivered: 1180,
  read: 910,
  replied: 64,
  failedTotal: 20,
  skippedTotal: 30,
  skipped: { opted_out: 18, dnd: 12 },
  failed: { '131026': 20 },
};
const CAMPAIGN_EXAMPLE = {
  id: ID,
  name: 'November EMI reminder',
  channelId: CHANNEL,
  status: 'running',
  pauseReason: null,
  variants: [{ key: 'A', templateId: TEMPLATE, splitPct: 100 }],
  abWinner: null,
  counters: COUNTERS,
  createdAt: AT,
};
const ERR_STATE = `\`409 WA_CAMPAIGN_NOT_EDITABLE\` / \`CONFLICT_INVALID_STATE\` when the status does not allow it.`;
const fail = publicErrors(true);

path(
  'get',
  '',
  {
    operationId: 'listWhatsAppCampaigns',
    scope: READ,
    summary: 'WhatsApp bulk campaigns',
    description:
      'Bulk template campaigns of the account, newest first, with live counters. Offset pagination (`page`, `limit`). Read limit class.',
  },
  {
    request: { query: ListCampaignsQuery },
    responses: { 200: page(WaCampaignSchema, CAMPAIGN_EXAMPLE), ...publicErrors() },
  },
);
path(
  'post',
  '',
  {
    operationId: 'createWhatsAppCampaign',
    scope: WRITE,
    summary: 'Create a draft bulk campaign',
    description:
      'A draft that sends **approved templates only** from one WhatsApp number (`channelId` from `GET /resources/whatsapp-numbers`). `variants` = 1–3 templates (A/B split in whole percent, sum 100). `variables` map each template placeholder to `contact.name`, `contact.phone`, a contact `field` (custom field key) or `static` text. `audience`: lists, segment, tags, contacts or an uploaded CSV. Nothing is sent until `start`. 30 creates / hour per account; write limit class.',
  },
  {
    request: json(CampaignBody, BODY_EXAMPLE),
    responses: {
      201: okWith(WaCampaignSchema, { ...CAMPAIGN_EXAMPLE, status: 'draft' }, 'Created'),
      ...publicErrors(),
    },
  },
);
path(
  'get',
  '/{id}',
  {
    operationId: 'getWhatsAppCampaign',
    scope: READ,
    summary: 'One bulk campaign with live counters',
    description:
      'Status, pause reason, variants and counters (sent / delivered / read / replied / failed / skipped by reason). Counters keep moving after the last send while delivery and replies arrive.',
  },
  {
    request: { params: CampaignIdParams },
    responses: { 200: okWith(WaCampaignSchema, CAMPAIGN_EXAMPLE), ...fail },
  },
);
path(
  'patch',
  '/{id}',
  {
    operationId: 'updateWhatsAppCampaign',
    scope: WRITE,
    summary: 'Edit a draft or scheduled bulk campaign',
    description: `Replaces the settings of a draft or scheduled campaign (same body as create). ${ERR_STATE}`,
  },
  {
    request: { params: CampaignIdParams, ...json(CampaignBody, BODY_EXAMPLE) },
    responses: {
      200: okWith(WaCampaignSchema, { ...CAMPAIGN_EXAMPLE, status: 'draft' }),
      ...fail,
      409: errors[409],
    },
  },
);
path(
  'delete',
  '/{id}',
  {
    operationId: 'deleteWhatsAppCampaign',
    scope: WRITE,
    summary: 'Delete a draft bulk campaign',
    description: `Deletes a draft (its uploaded header media is released). ${ERR_STATE}`,
  },
  {
    request: { params: CampaignIdParams },
    responses: { 204: noContentResponse, ...fail, 409: errors[409] },
  },
);
path(
  'post',
  '/{id}/estimate',
  {
    operationId: 'estimateWhatsAppCampaign',
    scope: READ,
    summary: 'Cost and wallet check of a bulk campaign',
    description:
      'Eligible recipients after skips (opted out, DND, no WhatsApp, recent sends), cost per template category × destination market at the account’s selling prices, and whether the wallet covers it. Nothing is written or charged.',
  },
  { request: { params: CampaignIdParams }, responses: { 200: ok(EstimateSchema), ...fail } },
);
for (const [p, operationId, summary, description] of [
  [
    '/start',
    'startWhatsAppCampaign',
    'Start (or schedule) a bulk campaign',
    '**`Idempotency-Key` required** — a retry with the same key returns the first answer and never starts twice. Takes the audience snapshot, checks the wallet and sends now or at `schedule.at`. Each message is charged when Meta bills it. Sending is paced per WhatsApp number (Business App 18 / Cloud API 75 messages per second) and by the number’s daily tier. Errors: `WA_CAMPAIGN_AUDIENCE_EMPTY`, `WALLET_INSUFFICIENT_BALANCE`, `409` when not a draft.',
  ],
  [
    '/pause',
    'pauseWhatsAppCampaign',
    'Pause a bulk campaign',
    'Sends stop between batches; messages already handed to Meta still deliver. Resume continues with the rest.',
  ],
  [
    '/resume',
    'resumeWhatsAppCampaign',
    'Resume a paused bulk campaign',
    'Continues sending. Refused (`409`) while the pause cause holds (e.g. the wallet is still empty).',
  ],
  [
    '/stop',
    'stopWhatsAppCampaign',
    'Stop a bulk campaign for good',
    'Recipients not sent yet are skipped as `stopped`; results of sent messages keep arriving. Cannot be undone.',
  ],
] as const) {
  path(
    'post',
    `/{id}${p}`,
    { operationId, scope: WRITE, summary, description },
    {
      request: { params: CampaignIdParams },
      responses: { 200: okWith(WaCampaignSchema, CAMPAIGN_EXAMPLE), ...fail, 409: errors[409] },
    },
  );
}
path(
  'post',
  '/{id}/retry-failed',
  {
    operationId: 'retryFailedWhatsAppCampaign',
    scope: WRITE,
    summary: 'Send again to recipients that failed with a retryable error',
    description:
      'Queues the recipients whose last error is retryable (rate limits, temporary Meta errors) once more. Returns how many were queued. Permanent errors (invalid number, opted out) are never retried.',
  },
  {
    request: { params: CampaignIdParams },
    responses: {
      200: okWith(z.object({ retried: z.number() }), { retried: 20 }),
      ...fail,
      409: errors[409],
    },
  },
);
path(
  'get',
  '/{id}/recipients',
  {
    operationId: 'listWhatsAppCampaignRecipients',
    scope: READ,
    summary: 'Recipients of a bulk campaign with their status',
    description:
      'One row per recipient: status (pending / sending / sent / delivered / read / failed / skipped), variant, error code. Phones are masked to the last 4 digits for API keys. Offset pagination; filter by `status`.',
  },
  {
    request: { params: CampaignIdParams, query: RecipientsQuery },
    responses: {
      200: page(RecipientSchema, { id: ID, status: 'delivered', phoneLast4: '0001' }),
      ...fail,
    },
  },
);
path(
  'get',
  '/{id}/export',
  {
    operationId: 'exportWhatsAppCampaignRecipients',
    scope: READ,
    summary: 'CSV of every recipient',
    description:
      'All recipients as CSV (UTF-8, formula cells escaped). API keys always get masked phones (keys never have `contacts.export`).',
  },
  {
    request: { params: CampaignIdParams },
    responses: {
      200: {
        description: 'CSV',
        content: {
          'text/csv': {
            schema: z.string(),
            example: 'name,phone,status\nAsha Verma,******0001,delivered\n',
          },
        },
      },
      ...fail,
    },
  },
);
path(
  'get',
  '/{id}/report',
  {
    operationId: 'getWhatsAppCampaignReport',
    scope: READ,
    summary: 'Funnel, cost, errors, per day and per variant',
    description:
      'Sent → delivered → read → replied funnel, money charged, top error codes, a per-day series and the A/B variant comparison (with the decided winner when `abWinner` is set).',
  },
  { request: { params: CampaignIdParams }, responses: { 200: ok(ReportSchema), ...fail } },
);
