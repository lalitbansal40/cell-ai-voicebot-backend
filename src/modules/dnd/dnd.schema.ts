import { DND_SOURCES } from '../../db/models/dnd-entry.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { ContactSchema } from '../contacts/contacts.schema';

export const ListDndQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  q: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .openapi({ description: 'Phone digits (any format)' }),
});

export const AddDndBody = z.strictObject({
  phone: z.string().trim().min(1).max(40).openapi({ example: '98765 43210' }),
  reason: z.string().trim().max(200).nullable().optional(),
});

export const DndIdParams = z.strictObject({ id: ObjectIdSchema });

export const DndEntrySchema = registry.register(
  'DndEntry',
  z.object({
    id: z.string(),
    phoneE164: z.string().openapi({ example: '+919876543210' }),
    reason: z.string().nullable(),
    source: z.enum(DND_SOURCES),
    addedBy: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const tags = ['Do-not-call'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/dnd-entries',
  tags,
  summary: 'Do-not-call numbers of the account (contacts.read)',
  security: bearer,
  request: { query: ListDndQuery },
  responses: { 200: okPage(DndEntrySchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/dnd-entries',
  tags,
  summary:
    'Add a number (contacts.write). Already listed → 200 with the existing entry, new → 201.',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: AddDndBody } } } },
  responses: {
    200: ok(DndEntrySchema, 'Already on the list'),
    201: ok(DndEntrySchema, 'Added'),
    403: errors[403],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/dnd-entries/{id}',
  tags,
  summary: "Remove a number (dnd.manage — owner / admin). A contact's opt-out stays.",
  security: bearer,
  request: { params: DndIdParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});

const OptOutParams = z.strictObject({ id: ObjectIdSchema });

registry.registerPath({
  method: 'post',
  path: '/api/v1/contacts/{id}/opt-out',
  tags,
  summary: 'Opt a contact out (contacts.write) — also puts the number on the do-not-call list',
  security: bearer,
  request: { params: OptOutParams },
  responses: { 200: ok(ContactSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/contacts/{id}/opt-out',
  tags,
  summary: 'Undo an opt-out (dnd.manage) — clears the opt-out and removes the do-not-call entry',
  security: bearer,
  request: { params: OptOutParams },
  responses: { 200: ok(ContactSchema), 403: errors[403], 404: errors[404] },
});
