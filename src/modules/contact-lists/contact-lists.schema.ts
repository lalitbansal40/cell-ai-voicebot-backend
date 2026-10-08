import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';

export const ListListsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  q: z.string().trim().min(1).max(100).optional(),
});

export const CreateListBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
});

export const UpdateListBody = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const ListIdParams = z.strictObject({ id: ObjectIdSchema });

export const ContactListSchema = registry.register(
  'ContactList',
  z.object({
    id: z.string(),
    name: z.string().openapi({ example: 'March borrowers' }),
    description: z.string().nullable(),
    source: z.object({
      type: z.enum(['upload', 'api', 'manual']),
      fileName: z.string().nullable(),
    }),
    contactCount: z.number().openapi({ description: 'Live contacts in the list (computed)' }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const tags = ['Contact lists'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-lists',
  tags,
  summary: 'Lists with contact counts (contacts.read)',
  security: bearer,
  request: { query: ListListsQuery },
  responses: { 200: okPage(ContactListSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contact-lists',
  tags,
  summary: 'Create a list (contacts.write; max 500; name unique, case-insensitive)',
  security: bearer,
  request: json(CreateListBody),
  responses: {
    201: ok(ContactListSchema, 'Created'),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-lists/{id}',
  tags,
  summary: 'One list with its contact count',
  security: bearer,
  request: { params: ListIdParams },
  responses: { 200: ok(ContactListSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/contact-lists/{id}',
  tags,
  summary: 'Rename / describe a list',
  security: bearer,
  request: { params: ListIdParams, ...json(UpdateListBody) },
  responses: {
    200: ok(ContactListSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/contact-lists/{id}',
  tags,
  summary: 'Delete a list — contacts stay; membership removed in the background (202)',
  security: bearer,
  request: { params: ListIdParams },
  responses: {
    202: ok(z.object({ jobQueued: z.literal(true) }), 'Accepted'),
    403: errors[403],
    404: errors[404],
  },
});
