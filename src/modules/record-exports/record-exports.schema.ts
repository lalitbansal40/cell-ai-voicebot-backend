import { CALL_PROVIDERS, CALL_STATUSES, SENTIMENTS } from '../../db/models/call.model';
import { EXPORT_FORMATS, EXPORT_KINDS } from '../../db/models/export-job.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { REPORT_TABS, ReportQuery } from '../reports/reports.schema';

const day = z.iso.date();

/** `POST /exports/calls` — the calls list filters; days in the account timezone. */
export const ExportCallsBody = z
  .strictObject({
    format: z.enum(EXPORT_FORMATS).default('csv'),
    from: day.optional(),
    to: day.optional(),
    status: z.array(z.enum(CALL_STATUSES)).max(8).optional(),
    flowId: ObjectIdSchema.optional(),
    agentId: ObjectIdSchema.optional(),
    campaignId: ObjectIdSchema.optional(),
    contactId: ObjectIdSchema.optional(),
    provider: z.enum(CALL_PROVIDERS).optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    mode: z.enum(['human', 'ai']).optional(),
    isTest: z.boolean().optional(),
    disposition: z
      .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
      .max(30)
      .optional(),
    sentiment: z.enum(SENTIMENTS).optional(),
    hasPromise: z.boolean().optional(),
    hasSummary: z.boolean().optional(),
    /** Contact name, like the calls list search. */
    q: z.string().trim().min(1).max(80).optional(),
    channelId: ObjectIdSchema.optional(),
    answeredBy: ObjectIdSchema.optional(),
    /** Full phone numbers — needs `contacts.export` too. */
    includePhone: z.boolean().default(false),
    /** The AI summary column. */
    includeSummary: z.boolean().default(false),
  })
  .refine((b) => !b.from || !b.to || b.from <= b.to, {
    path: ['to'],
    message: 'The last day must be on or after the first day.',
  });

/** `POST /exports/messages` — WhatsApp message metadata, never the text. */
export const ExportMessagesBody = z
  .strictObject({
    format: z.enum(EXPORT_FORMATS).default('csv'),
    from: day,
    to: day,
    channelId: ObjectIdSchema.optional(),
    direction: z.enum(['in', 'out']).optional(),
  })
  .refine((b) => b.from <= b.to, {
    path: ['to'],
    message: 'The last day must be on or after the first day.',
  });

/** `POST /exports/report` — the numbers of one report tab with its filters. */
export const ExportReportBody = z.strictObject({
  format: z.enum(EXPORT_FORMATS).default('csv'),
  tab: z.enum(REPORT_TABS),
  query: ReportQuery.default({}),
});

export const ExportParams = z.strictObject({ id: ObjectIdSchema });
export const ListRecordExportsQuery = z.strictObject({ ...PaginationQuerySchema.shape });

export const RecordExportSchema = registry.register(
  'RecordExport',
  z.object({
    id: z.string(),
    kind: z.enum(EXPORT_KINDS),
    format: z.enum(EXPORT_FORMATS),
    status: z.enum(['pending', 'processing', 'ready', 'failed', 'expired']),
    progress: z.object({ processed: z.number(), total: z.number() }),
    rowCount: z.number(),
    errorMessage: z.string().nullable(),
    completedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    downloadUrl: z.string().optional(),
  }),
);

const tags = ['Exports'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const created = {
  202: ok(RecordExportSchema, 'Queued'),
  401: errors[401],
  403: errors[403],
  409: errors[409],
  422: errors[422],
};

registry.registerPath({
  method: 'post',
  path: '/api/v1/exports/calls',
  tags,
  summary:
    'Export calls as CSV / XLSX (calls.export; includePhone needs contacts.export; ≤ 200,000 rows; one export at a time; never while impersonating)',
  security: bearer,
  request: json(ExportCallsBody),
  responses: created,
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/exports/messages',
  tags,
  summary: 'Export WhatsApp message metadata — never the text (reports.export; ≤ 200,000 rows)',
  security: bearer,
  request: json(ExportMessagesBody),
  responses: created,
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/exports/report',
  tags,
  summary: "Export a report tab's numbers (reports.export)",
  security: bearer,
  request: json(ExportReportBody),
  responses: created,
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/exports/{id}',
  tags,
  summary:
    'An export of calls / messages / a report; a 15-minute download link once ready (the kind’s permission)',
  security: bearer,
  request: { params: ExportParams },
  responses: { 200: ok(RecordExportSchema), 401: errors[401], 403: errors[403], 404: errors[404] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/exports',
  tags,
  summary:
    'Recent exports of calls (calls.export) and messages / reports (reports.export), newest first',
  security: bearer,
  request: { query: ListRecordExportsQuery },
  responses: { 200: okPage(RecordExportSchema), 401: errors[401], 403: errors[403] },
});
