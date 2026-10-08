import { IMPORT_KINDS, IMPORT_STATUSES } from '../../db/models/import-job.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { FieldTypeSchema } from '../custom-fields/custom-fields.schema';

import { CONTACT_TARGETS, DND_TARGETS } from './mapping';

const TARGETS = [...new Set([...CONTACT_TARGETS, ...DND_TARGETS])] as [string, ...string[]];

export const ColumnMappingSchema = registry.register(
  'ImportColumnMapping',
  z.strictObject({
    index: z.number().int().min(0).max(99),
    target: z.enum(TARGETS),
    key: z.string().max(40).optional(),
    label: z.string().trim().max(80).optional(),
    type: FieldTypeSchema.optional(),
    dateFormat: z.enum(['DMY', 'MDY', 'YMD']).optional(),
  }),
);

export const ImportOptionsSchema = registry.register(
  'ImportOptions',
  z.strictObject({
    list: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('new'), name: z.string().trim().min(1).max(100) }),
      z.strictObject({ mode: z.literal('existing'), listId: ObjectIdSchema }),
    ]),
    updateExisting: z.boolean().default(true),
    tags: z.array(z.string().max(40)).max(20).default([]),
    consentSource: z.string().trim().max(120).nullable().optional(),
  }),
);

export const SetMappingBody = z.strictObject({
  sheet: z.string().max(100).optional(),
  columns: z.array(ColumnMappingSchema).min(1).max(100),
  options: ImportOptionsSchema.optional().openapi({
    description: 'Contacts imports only (default: new list named after the file)',
  }),
});

export const UploadFields = z.strictObject({
  kind: z.enum(IMPORT_KINDS).default('contacts'),
});

export const ImportIdParams = z.strictObject({ id: ObjectIdSchema });

export const ListImportsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  kind: z.enum(IMPORT_KINDS).optional(),
  status: z.enum(IMPORT_STATUSES).optional(),
});

const TotalsSchema = z.object({
  rows: z.number(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  invalid: z.number(),
  duplicates: z.number(),
  dnd: z.number(),
});

export const ImportJobSchema = registry.register(
  'ImportJob',
  z.object({
    id: z.string(),
    kind: z.enum(IMPORT_KINDS),
    fileName: z.string(),
    fileType: z.enum(['csv', 'xlsx']),
    fileSize: z.number(),
    sheet: z.string().nullable(),
    sheets: z.array(z.string()),
    columns: z.array(
      z.object({ index: z.number(), header: z.string(), samples: z.array(z.string()) }),
    ),
    rowCount: z.number(),
    mapping: z.object({ columns: z.array(ColumnMappingSchema) }).nullable(),
    options: ImportOptionsSchema.nullable(),
    suggestedMapping: z
      .array(ColumnMappingSchema)
      .optional()
      .openapi({ description: 'Detail only, while the job can still be mapped' }),
    status: z.enum(IMPORT_STATUSES),
    progress: z.object({ processed: z.number(), total: z.number() }),
    totals: TotalsSchema,
    problemRows: z.array(z.object({ row: z.number(), reasons: z.array(z.string()) })),
    hasErrorReport: z.boolean(),
    listId: z.string().nullable(),
    warnings: z.array(z.string()),
    errorMessage: z.string().nullable(),
    createdBy: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    canceledAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const tags = ['Contact imports'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contact-imports',
  tags,
  summary:
    'Upload a .csv / .xlsx (≤ 10 MB, ≤ 50,000 rows, ≤ 100 columns) — returns columns, samples and a suggested mapping (contacts.import; kind=dnd also needs contacts.write)',
  security: bearer,
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.string().openapi({ type: 'string', format: 'binary' }),
            kind: z.enum(IMPORT_KINDS).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: ok(ImportJobSchema, 'Uploaded'),
    403: errors[403],
    413: { description: 'File larger than 10 MB (PAYLOAD_TOO_LARGE)' },
    415: { description: 'Not a .csv / .xlsx file (UNSUPPORTED_MEDIA_TYPE)' },
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-imports',
  tags,
  summary: 'Import history (contacts.read)',
  security: bearer,
  request: { query: ListImportsQuery },
  responses: { 200: okPage(ImportJobSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-imports/template.csv',
  tags,
  summary: 'CSV template with the contact columns and every custom field',
  security: bearer,
  responses: { 200: { description: 'text/csv', content: { 'text/csv': { schema: z.string() } } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-imports/{id}',
  tags,
  summary: 'One import job (with suggested mapping while mappable)',
  security: bearer,
  request: { params: ImportIdParams },
  responses: { 200: ok(ImportJobSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/contact-imports/{id}/mapping',
  tags,
  summary: 'Set column mapping + options (uploaded / mapped / validated → mapped)',
  security: bearer,
  request: { params: ImportIdParams, ...json(SetMappingBody) },
  responses: {
    200: ok(ImportJobSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contact-imports/{id}/cancel',
  tags,
  summary:
    'Cancel — before the import: file deleted; while importing: stops after the current batch',
  security: bearer,
  request: { params: ImportIdParams },
  responses: { 200: ok(ImportJobSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-imports/{id}/error-report',
  tags,
  summary: 'Signed download link (15 min) for the CSV of rejected rows',
  security: bearer,
  request: { params: ImportIdParams },
  responses: {
    200: ok(z.object({ url: z.string(), expiresInSec: z.number() })),
    403: errors[403],
    404: errors[404],
  },
});
