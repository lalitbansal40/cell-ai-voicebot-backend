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
