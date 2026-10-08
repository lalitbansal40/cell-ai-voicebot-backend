import { EXPORT_SCOPES, EXPORT_STATUSES } from '../../db/models/export-job.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { ContactFilterSchema } from '../contacts/filter/filter.schema';

/** Fixed export columns (custom field keys may be added too). */
export const BASE_EXPORT_COLUMNS = [
  'name',
  'phone',
  'email',
  'external_id',
  'tags',
  'lists',
  'dnd',
  'opted_out',
  'consent_source',
  'consent_at',
  'created_at',
] as const;

export const CreateExportBody = z
  .strictObject({
    scope: z.enum(EXPORT_SCOPES),
    ids: z.array(ObjectIdSchema).min(1).max(1000).optional(),
    filter: ContactFilterSchema.optional(),
    listId: ObjectIdSchema.optional(),
    segmentId: ObjectIdSchema.optional(),
    columns: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(100)
      .optional()
      .openapi({
        description: `Default: all — ${BASE_EXPORT_COLUMNS.join(', ')} + every custom field key`,
      }),
  })
  .superRefine((b, ctx) => {
    const need = { ids: b.ids, filter: b.filter, list: b.listId, segment: b.segmentId }[b.scope];
    if (need === undefined)
      ctx.addIssue({
        code: 'custom',
        path: [b.scope === 'list' ? 'listId' : b.scope === 'segment' ? 'segmentId' : b.scope],
        message: `Required for scope "${b.scope}"`,
      });
  });

export const ExportIdParams = z.strictObject({ id: ObjectIdSchema });
export const ListExportsQuery = z.strictObject({ ...PaginationQuerySchema.shape });

export const ExportJobSchema = registry.register(
  'ExportJob',
  z.object({
    id: z.string(),
    scope: z.enum(EXPORT_SCOPES),
    columns: z.array(z.string()),
    status: z.enum(EXPORT_STATUSES),
    progress: z.object({ processed: z.number(), total: z.number() }),
    rowCount: z.number(),
    errorMessage: z.string().nullable(),
    createdBy: z.string(),
    completedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    downloadUrl: z
      .string()
      .optional()
      .openapi({ description: 'Signed (15 min), detail only while ready' }),
  }),
);

const tags = ['Contact exports'];

registry.registerPath({
  method: 'post',
  path: '/api/v1/contact-exports',
  tags,
  summary:
    'Export contacts as CSV in the background (contacts.export; not while impersonating; ≤ 100,000 rows; file kept 24 h)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: CreateExportBody } } } },
  responses: {
    202: ok(ExportJobSchema, 'Queued'),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-exports',
  tags,
  summary: 'Export history',
  security: bearer,
  request: { query: ListExportsQuery },
  responses: { 200: okPage(ExportJobSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-exports/{id}',
  tags,
  summary: 'Export status, with a fresh signed download link when ready',
  security: bearer,
  request: { params: ExportIdParams },
  responses: { 200: ok(ExportJobSchema), 403: errors[403], 404: errors[404] },
});
