import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';
import { ContactSchema } from '../contacts/contacts.schema';
import { ContactFilterSchema } from '../contacts/filter/filter.schema';

export const SegmentIdParams = z.strictObject({ id: ObjectIdSchema });

export const ListSegmentsQuery = z.strictObject({
  withCounts: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const CreateSegmentBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  filter: ContactFilterSchema,
});

export const UpdateSegmentBody = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    filter: ContactFilterSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const PreviewSegmentBody = z.strictObject({ filter: ContactFilterSchema });

export const SegmentSchema = registry.register(
  'Segment',
  z.object({
    id: z.string(),
    name: z.string().openapi({ example: 'Overdue > 30 days' }),
    filter: ContactFilterSchema,
    invalidConditions: z.array(z.number()).openapi({
      description:
        'Indexes of conditions that no longer work (field deleted) — the segment matches nothing',
    }),
    contactCount: z.number().optional().openapi({ description: 'Only with `?withCounts=true`' }),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const SegmentPreviewSchema = registry.register(
  'SegmentPreview',
  z.object({ count: z.number(), sample: z.array(ContactSchema) }),
);

const tags = ['Segments'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/segments',
  tags,
  summary: 'Saved contact filters (contacts.read)',
  security: bearer,
  request: { query: ListSegmentsQuery },
  responses: { 200: ok(z.array(SegmentSchema)), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/segments',
  tags,
  summary: 'Save a filter as a segment (contacts.write; max 100)',
  security: bearer,
  request: json(CreateSegmentBody),
  responses: {
    201: ok(SegmentSchema, 'Created'),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/segments/preview',
  tags,
  summary: 'Count + 5 newest contacts for a filter (segment builder)',
  security: bearer,
  request: json(PreviewSegmentBody),
  responses: { 200: ok(SegmentPreviewSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/segments/{id}',
  tags,
  summary: 'One segment with its contact count',
  security: bearer,
  request: { params: SegmentIdParams },
  responses: { 200: ok(SegmentSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/segments/{id}',
  tags,
  summary: 'Rename a segment or change its filter',
  security: bearer,
  request: { params: SegmentIdParams, ...json(UpdateSegmentBody) },
  responses: {
    200: ok(SegmentSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/segments/{id}',
  tags,
  summary: 'Delete a segment (contacts are not affected)',
  security: bearer,
  request: { params: SegmentIdParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});
