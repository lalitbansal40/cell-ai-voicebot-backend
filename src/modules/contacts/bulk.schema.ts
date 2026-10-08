import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { ContactFilterSchema } from './filter/filter.schema';

export const BULK_ACTIONS = [
  'add_tags',
  'remove_tags',
  'add_to_list',
  'remove_from_list',
  'delete',
  'add_to_dnd',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

const Tags = z.strictObject({ tags: z.array(z.string().max(40)).min(1).max(20) });
const List = z.strictObject({ listId: ObjectIdSchema });

export const BulkBody = z
  .strictObject({
    action: z.enum(BULK_ACTIONS),
    ids: z.array(ObjectIdSchema).min(1).max(1000).optional(),
    filter: ContactFilterSchema.optional(),
    payload: z
      .strictObject({
        tags: z.array(z.string().max(40)).max(20).optional(),
        listId: ObjectIdSchema.optional(),
        reason: z.string().trim().max(200).optional(),
      })
      .default({}),
  })
  .superRefine((b, ctx) => {
    if ((b.ids === undefined) === (b.filter === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['ids'], message: 'Send either ids or filter' });
    }
    if (
      (b.action === 'add_tags' || b.action === 'remove_tags') &&
      !Tags.safeParse({ tags: b.payload.tags }).success
    ) {
      ctx.addIssue({ code: 'custom', path: ['payload', 'tags'], message: 'Give 1–20 tags' });
    }
    if (
      (b.action === 'add_to_list' || b.action === 'remove_from_list') &&
      !List.safeParse({ listId: b.payload.listId }).success
    ) {
      ctx.addIssue({ code: 'custom', path: ['payload', 'listId'], message: 'Choose a list' });
    }
  });

registry.registerPath({
  method: 'post',
  path: '/api/v1/contacts/bulk',
  tags: ['Contacts'],
  summary:
    'Bulk action (contacts.write): ≤ 1,000 ids → done now (200 { count }); a filter (≤ 100,000 contacts) → background job (202), result via WS contacts.bulk_completed',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: BulkBody } } } },
  responses: {
    200: ok(z.object({ count: z.number() }), 'Done'),
    202: ok(z.object({ jobQueued: z.literal(true), count: z.number() }), 'Queued'),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
