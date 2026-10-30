import { SHEET_RUN_STATUSES, SHEET_SCHEDULES } from '../../db/models/sheet-import.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';
import { ColumnMappingSchema } from '../contact-imports/contact-imports.schema';

export const CreateSheetImportBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2048).openapi({
    example: 'https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?gid=0&single=true&output=csv',
  }),
  schedule: z.enum(SHEET_SCHEDULES),
  mapping: z.array(ColumnMappingSchema).min(1).max(200),
  updateExisting: z.boolean().default(true),
  tags: z.array(z.string().max(40)).max(20).default([]),
});
export const SheetImportParams = z.strictObject({ id: ObjectIdSchema });
export const PreviewSheetBody = z.strictObject({ url: CreateSheetImportBody.shape.url });

export const SheetPreviewSchema = registry.register(
  'SheetPreview',
  z.object({
    columns: z.array(
      z.object({ index: z.number().int(), header: z.string(), samples: z.array(z.string()) }),
    ),
    rowCount: z.number().int(),
    suggestedMapping: z.array(ColumnMappingSchema),
  }),
);

export const SheetImportSchema = registry.register(
  'SheetImport',
  z.object({
    id: z.string(),
    name: z.string(),
    schedule: z.enum(SHEET_SCHEDULES),
    mapping: z.object({ columns: z.array(z.record(z.string(), z.unknown())) }),
    listId: z.string(),
    listName: z.string().nullable(),
    updateExisting: z.boolean(),
    tags: z.array(z.string()),
    active: z.boolean(),
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    lastStatus: z.enum(SHEET_RUN_STATUSES).nullable(),
    lastError: z.string().nullable(),
    lastResult: z
      .object({
        importJobId: z.string().nullable(),
        rows: z.number().int(),
        created: z.number().int(),
        updated: z.number().int(),
        failed: z.number().int(),
      })
      .nullable(),
    createdAt: z.string(),
  }),
);

const tags = ['Contact imports'];
const base = '/api/v1/sheet-imports';
registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Google Sheet imports (contacts.import) — the sheet link is never returned',
  security: bearer,
  responses: { 200: ok(z.array(SheetImportSchema)), 403: errors[403] },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary:
    'Import contacts from a Google Sheet published as CSV — once, hourly or daily (≤ 5); checked and queued now. 422 SHEET_URL_INVALID',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: CreateSheetImportBody } } } },
  responses: { 201: ok(SheetImportSchema), 403: errors[403], 409: errors[409], 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/preview`,
  tags,
  summary: 'Columns, sample values and a suggested mapping of a published sheet (nothing stored)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: PreviewSheetBody } } } },
  responses: { 200: ok(SheetPreviewSchema), 403: errors[403], 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/run`,
  tags,
  summary: 'Import the sheet again now',
  security: bearer,
  request: { params: SheetImportParams },
  responses: { 202: ok(SheetImportSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary: 'Stop importing this sheet (imported contacts and their list stay)',
  security: bearer,
  request: { params: SheetImportParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});
