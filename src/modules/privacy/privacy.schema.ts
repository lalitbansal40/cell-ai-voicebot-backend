import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

export const EraseParams = z.strictObject({ id: ObjectIdSchema });

const Confirm = z.literal('ERASE').openapi({ description: 'Type ERASE to confirm' });

export const EraseContactBody = z.strictObject({ confirm: Confirm });
export const BulkEraseBody = z.strictObject({
  ids: z.array(ObjectIdSchema).min(1).max(1000),
  confirm: Confirm,
});

export const AccountExportBody = z.strictObject({
  password: z.string().min(1).max(200),
  includeRecordings: z.boolean().optional(),
});
export const AccountDeleteBody = z.strictObject({
  password: z.string().min(1).max(200),
  confirmName: z.string().trim().min(1).max(80),
});

export const AccountExportSchema = registry.register(
  'AccountExport',
  z.object({
    id: z.string(),
    status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
    includeRecordings: z.boolean(),
    sizeBytes: z.number().nullable(),
    counts: z.record(z.string(), z.number()),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    url: z.string().nullable().optional().openapi({ description: 'Valid for 24 hours' }),
  }),
);

export const AccountDeletionSchema = registry.register(
  'AccountDeletion',
  z.object({ status: z.literal('scheduled'), scheduledFor: z.string() }),
);

export const EraseResultSchema = registry.register(
  'EraseResult',
  z.object({
    erased: z.literal(true),
    counts: z.record(z.string(), z.number()).openapi({ description: 'Rows changed per store' }),
  }),
);

export const EraseJobSchema = registry.register(
  'EraseJob',
  z.object({
    id: z.string(),
    status: z.enum(['queued', 'running', 'done', 'failed']),
    total: z.number(),
    done: z.number(),
    retried: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const tags = ['Privacy'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contacts/{id}/erase',
  tags,
  summary: 'Erase a contact everywhere and keep the number suppressed (contacts.erase)',
  security: bearer,
  request: { params: EraseParams, ...json(EraseContactBody) },
  responses: {
    200: ok(EraseResultSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contacts/bulk-erase',
  tags,
  summary: 'Erase up to 1,000 contacts in the background (contacts.erase)',
  security: bearer,
  request: json(BulkEraseBody),
  responses: {
    202: ok(EraseJobSchema, 'Accepted'),
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contacts/erase-jobs/{id}',
  tags,
  summary: 'Progress of a bulk erase (contacts.erase)',
  security: bearer,
  request: { params: EraseParams },
  responses: { 200: ok(EraseJobSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/account/export',
  tags,
  summary: 'Export all account data as one zip (owner, password again)',
  security: bearer,
  request: json(AccountExportBody),
  responses: {
    202: ok(AccountExportSchema, 'Accepted'),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/account/exports',
  tags,
  summary: 'Recent account exports (owner)',
  security: bearer,
  responses: { 200: ok(z.array(AccountExportSchema)), 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/account/exports/{id}',
  tags,
  summary: 'One export, with a download link when ready (owner)',
  security: bearer,
  request: { params: EraseParams },
  responses: { 200: ok(AccountExportSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/account/delete',
  tags,
  summary: 'Schedule the deletion of this account in 7 days (owner, password and typed name)',
  security: bearer,
  request: json(AccountDeleteBody),
  responses: {
    200: ok(AccountDeletionSchema),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/account/delete/cancel',
  tags,
  summary: 'Cancel a scheduled deletion (owner)',
  security: bearer,
  responses: {
    200: ok(z.object({ canceled: z.literal(true) })),
    403: errors[403],
    409: errors[409],
  },
});
