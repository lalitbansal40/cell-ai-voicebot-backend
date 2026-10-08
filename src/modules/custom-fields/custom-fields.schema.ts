import { FIELD_TYPES } from '../../db/models/custom-field.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Keys the system uses itself — never custom fields (PHASE_3_PLAN §1b). */
export const RESERVED_FIELD_KEYS = [
  'name',
  'phone',
  'email',
  'tags',
  'lists',
  'id',
  'account',
  'contact',
  'external_id',
  'created_at',
  'updated_at',
  'dnd',
  'opted_out',
  'consent',
  'source',
] as const;

export const FieldTypeSchema = z.enum(FIELD_TYPES).openapi('FieldType');

/** Input value: rupees for currency, `DD/MM/YYYY` or `YYYY-MM-DD` for dates. */
const DefaultValueInput = z
  .union([z.string().max(1000), z.number()])
  .nullable()
  .openapi({
    description: 'Currency in rupees (stored as micros); dates `YYYY-MM-DD` or `DD/MM/YYYY`',
  });

export const FieldKeySchema = z
  .string()
  .regex(FIELD_KEY, 'Lower-case letters, digits and _ ; must start with a letter (max 40)')
  .refine(
    (key) => !(RESERVED_FIELD_KEYS as readonly string[]).includes(key),
    'This key is reserved',
  )
  .openapi({ example: 'loan_amount' });

export const CreateCustomFieldBody = z.strictObject({
  key: FieldKeySchema,
  label: z.string().trim().min(1).max(80),
  type: FieldTypeSchema,
  required: z.boolean().default(false),
  defaultValue: DefaultValueInput.optional(),
});

export const UpdateCustomFieldBody = z
  .strictObject({
    label: z.string().trim().min(1).max(80).optional(),
    type: FieldTypeSchema.optional(),
    required: z.boolean().optional(),
    defaultValue: DefaultValueInput.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const ReorderCustomFieldsBody = z.strictObject({
  ids: z.array(ObjectIdSchema).min(1).max(50),
});

export const CustomFieldIdParams = z.strictObject({ id: ObjectIdSchema });

export const ListCustomFieldsQuery = z.strictObject({
  withUsage: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const CustomFieldSchema = registry.register(
  'CustomField',
  z.object({
    id: z.string(),
    key: z.string().openapi({ example: 'loan_amount' }),
    label: z.string().openapi({ example: 'Loan amount' }),
    type: FieldTypeSchema,
    required: z.boolean(),
    defaultValue: z
      .union([z.string(), z.number()])
      .nullable()
      .openapi({ description: 'Stored form: currency in micros, date `YYYY-MM-DD`' }),
    order: z.number(),
    usageCount: z
      .number()
      .optional()
      .openapi({ description: 'Contacts with a value (only with `?withUsage=true`)' }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const tags = ['Custom fields'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/custom-fields',
  tags,
  summary: 'Custom field definitions in display order (contacts.read)',
  security: bearer,
  request: { query: ListCustomFieldsQuery },
  responses: { 200: ok(z.array(CustomFieldSchema)), 401: errors[401], 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/custom-fields',
  tags,
  summary: 'Create a custom field (contacts.write; max 50 per account; key immutable)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: CreateCustomFieldBody } } } },
  responses: {
    201: ok(CustomFieldSchema, 'Created'),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/custom-fields/{id}',
  tags,
  summary: 'Update label / required / default; type only while no contact has a value',
  security: bearer,
  request: {
    params: CustomFieldIdParams,
    body: { content: { 'application/json': { schema: UpdateCustomFieldBody } } },
  },
  responses: {
    200: ok(CustomFieldSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/custom-fields/order',
  tags,
  summary: 'Set the display order (all field ids of the account, in order)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: ReorderCustomFieldsBody } } } },
  responses: { 200: ok(z.array(CustomFieldSchema)), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/custom-fields/{id}',
  tags,
  summary: 'Delete a field; its values are removed from all contacts in the background (202)',
  security: bearer,
  request: { params: CustomFieldIdParams },
  responses: {
    202: ok(z.object({ jobQueued: z.literal(true) }), 'Accepted — values removed in background'),
    403: errors[403],
    404: errors[404],
  },
});
