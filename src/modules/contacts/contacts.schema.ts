import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema, sortSchema } from '../../shared/validation/schemas';

import { ContactFilterSchema } from './filter/filter.schema';

export const CONTACT_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'lastCalledAt'] as const;

const VariableInput = z.union([z.string().max(1000), z.number(), z.null()]);

export const VariablesInputSchema = z
  .record(z.string().min(1).max(40), VariableInput)
  .refine((v) => Object.keys(v).length <= 50, 'At most 50 variables')
  .openapi({
    description:
      'By field key. Currency in rupees (stored as micros), dates `YYYY-MM-DD` / `DD/MM/YYYY`; `null` clears (update only).',
    example: { loan_amount: 12500.5, due_date: '2026-10-05' },
  });

export const ConsentInputSchema = z.strictObject({
  source: z.string().trim().min(1).max(120).openapi({ example: 'Loan agreement' }),
  at: z.iso
    .datetime({ offset: true })
    .refine((at) => new Date(at).getTime() <= Date.now() + 60_000, 'Must not be in the future'),
});

const contactFields = {
  name: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  externalId: z.string().trim().min(1).max(100).nullable().optional(),
  variables: VariablesInputSchema.optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  listIds: z.array(ObjectIdSchema).max(50).optional(),
  consent: ConsentInputSchema.nullable().optional(),
};

export const CreateContactBody = z.strictObject({
  phone: z.string().trim().min(1).max(40).openapi({ example: '98765 43210' }),
  ...contactFields,
});

export const UpdateContactBody = z
  .strictObject({
    phone: z.string().trim().min(1).max(40).optional(),
    ...contactFields,
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const ContactIdParams = z.strictObject({ id: ObjectIdSchema });

const BoolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));
const CommaList = z
  .string()
  .max(1000)
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

export const ListContactsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  sort: sortSchema(CONTACT_SORT_FIELDS),
  q: z.string().trim().min(1).max(100).optional(),
  listId: ObjectIdSchema.optional(),
  tag: CommaList.openapi({ description: 'Comma-separated — any of them' }),
  tagsAll: CommaList.openapi({ description: 'Comma-separated — all of them' }),
  dnd: BoolQuery,
  optedOut: BoolQuery,
  segmentId: ObjectIdSchema.optional(),
  createdFrom: z.union([z.iso.datetime({ offset: true }), z.iso.date()]).optional(),
  createdTo: z.union([z.iso.datetime({ offset: true }), z.iso.date()]).optional(),
});

export const SearchContactsBody = z.strictObject({
  filter: ContactFilterSchema.default({}),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  sort: sortSchema(CONTACT_SORT_FIELDS),
});

export const ContactSchema = registry.register(
  'Contact',
  z.object({
    id: z.string(),
    phoneE164: z.string().openapi({ example: '+919876543210' }),
    name: z.string().nullable(),
    email: z.string().nullable(),
    externalId: z.string().nullable(),
    variables: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .openapi({ description: 'Stored form: currency in micros, dates `YYYY-MM-DD`' }),
    tags: z.array(z.string()),
    listIds: z.array(z.string()),
    dnd: z.boolean(),
    optedOutAt: z.string().nullable(),
    consent: z.object({ source: z.string(), at: z.string() }).nullable(),
    source: z.object({
      type: z.enum(['manual', 'import', 'api']),
      importJobId: z.string().nullable(),
    }),
    lastCalledAt: z.string().nullable(),
    callCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lists: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .optional()
      .openapi({ description: 'Detail only' }),
  }),
);

const tags = ['Contacts'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contacts',
  tags,
  summary: 'Contacts with search, filters, sort, pagination (contacts.read)',
  security: bearer,
  request: { query: ListContactsQuery },
  responses: { 200: okPage(ContactSchema), 401: errors[401], 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contacts/search',
  tags,
  summary: 'Contacts matching a filter body (segment builder / advanced filter)',
  security: bearer,
  request: json(SearchContactsBody),
  responses: { 200: okPage(ContactSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contacts/{id}',
  tags,
  summary: 'One contact with its list names',
  security: bearer,
  request: { params: ContactIdParams },
  responses: { 200: ok(ContactSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/contacts',
  tags,
  summary:
    'Create a contact (contacts.write). A live duplicate phone / external id → 409 with existingId; a deleted one is revived.',
  security: bearer,
  request: json(CreateContactBody),
  responses: {
    201: ok(ContactSchema, 'Created'),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/contacts/{id}',
  tags,
  summary: 'Update a contact — variables merge, `null` clears; tags / lists replace',
  security: bearer,
  request: { params: ContactIdParams, ...json(UpdateContactBody) },
  responses: {
    200: ok(ContactSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/contacts/{id}',
  tags,
  summary: 'Delete a contact (restorable by re-creating the phone within 30 days)',
  security: bearer,
  request: { params: ContactIdParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/contact-tags',
  tags,
  summary: 'Tags in use with contact counts (top 200)',
  security: bearer,
  responses: {
    200: ok(z.array(z.object({ tag: z.string(), count: z.number() }))),
    403: errors[403],
  },
});
