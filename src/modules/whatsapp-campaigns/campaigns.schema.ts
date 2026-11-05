import { WA_RECIPIENT_STATUSES } from '../../db/models/whatsapp-campaign-recipient.model';
import {
  WA_CAMPAIGN_PAUSE_REASONS,
  WA_CAMPAIGN_STATUSES,
  WA_VARIABLE_KINDS,
} from '../../db/models/whatsapp-campaign.model';
import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
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

const tags = ['WhatsApp campaigns'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
type Extra = Pick<Parameters<typeof registry.registerPath>[0], 'request' | 'responses'>;
const path = (
  method: 'get' | 'post' | 'patch' | 'delete',
  p: string,
  summary: string,
  extra: Extra,
) =>
  registry.registerPath({
    method,
    path: `/api/v1/whatsapp-campaigns${p}`,
    tags,
    security: bearer,
    summary,
    ...extra,
  });
const page = <T extends z.ZodType>(item: T) => ({
  description: 'OK',
  content: {
    'application/json': {
      schema: z.object({
        success: z.literal(true),
        data: z.array(item),
        meta: OffsetPageMetaSchema,
      }),
    },
  },
});
const fail = { 403: errors[403], 404: errors[404] };

path('get', '', 'WhatsApp campaigns (whatsapp.campaigns.read)', {
  request: { query: ListCampaignsQuery },
  responses: { 200: page(WaCampaignSchema), 403: errors[403] },
});
path('post', '', 'Create a draft campaign (whatsapp.campaigns.write; 30 / h)', {
  request: json(CampaignBody),
  responses: { 201: ok(WaCampaignSchema), 403: errors[403], 422: errors[422] },
});
path('get', '/{id}', 'One campaign with live counters', {
  request: { params: CampaignIdParams },
  responses: { 200: ok(WaCampaignSchema), ...fail },
});
path(
  'patch',
  '/{id}',
  'Edit a draft or scheduled campaign (409 WA_CAMPAIGN_NOT_EDITABLE after start)',
  {
    request: { params: CampaignIdParams, ...json(CampaignBody) },
    responses: { 200: ok(WaCampaignSchema), ...fail, 409: errors[409], 422: errors[422] },
  },
);
path('delete', '/{id}', 'Delete a draft', {
  request: { params: CampaignIdParams },
  responses: { 204: noContentResponse, ...fail, 409: errors[409] },
});
path('post', '/{id}/estimate', 'Cost by market × template price, and the wallet check', {
  request: { params: CampaignIdParams },
  responses: { 200: ok(EstimateSchema), ...fail },
});
for (const [p, summary] of [
  [
    '/start',
    'Snapshot the audience, check the wallet, send now or at the scheduled time (Idempotency-Key)',
  ],
  ['/pause', 'Pause (sends stop between batches)'],
  ['/resume', 'Resume a paused campaign'],
  ['/stop', 'Stop for good: the rest are skipped `stopped`'],
] as const) {
  path('post', `/{id}${p}`, summary, {
    request: { params: CampaignIdParams },
    responses: { 200: ok(WaCampaignSchema), ...fail, 409: errors[409], 422: errors[422] },
  });
}
path('post', '/{id}/retry-failed', 'Send again to failed recipients with a retryable error', {
  request: { params: CampaignIdParams },
  responses: { 200: ok(z.object({ retried: z.number() })), ...fail, 409: errors[409] },
});
path('get', '/{id}/recipients', 'Recipients with status (phones masked)', {
  request: { params: CampaignIdParams, query: RecipientsQuery },
  responses: { 200: page(RecipientSchema), ...fail },
});
path('get', '/{id}/export', 'CSV of every recipient (phones only with contacts.export)', {
  request: { params: CampaignIdParams },
  responses: {
    200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } },
    ...fail,
  },
});
path('get', '/{id}/report', 'Funnel, cost, errors, per day, variants', {
  request: { params: CampaignIdParams },
  responses: { 200: ok(ReportSchema), ...fail },
});
