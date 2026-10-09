import { NOTIFICATION_TYPES } from '../../db/models/notification.model';
import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { CursorQuerySchema, ObjectIdSchema } from '../../shared/validation/schemas';

export const ListNotificationsQuery = z.strictObject({
  ...CursorQuerySchema.shape,
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const NotificationIdParams = z.strictObject({ id: ObjectIdSchema });

export const NotificationSchema = registry.register(
  'Notification',
  z.object({
    id: z.string(),
    type: z.enum(NOTIFICATION_TYPES),
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const tags = ['Notifications'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/notifications',
  tags,
  summary: 'My notifications, newest first (cursor pagination)',
  security: bearer,
  request: { query: ListNotificationsQuery },
  responses: {
    200: {
      description: 'Notifications',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(NotificationSchema),
            meta: CursorPageMetaSchema,
          }),
        },
      },
    },
    401: errors[401],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/notifications/unread-count',
  tags,
  summary: 'Number of my unread notifications',
  security: bearer,
  responses: { 200: ok(z.object({ count: z.number() })), 401: errors[401] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/notifications/{id}/read',
  tags,
  summary: 'Mark one of my notifications as read',
  security: bearer,
  request: { params: NotificationIdParams },
  responses: { 200: ok(NotificationSchema), 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/notifications/read-all',
  tags,
  summary: 'Mark all my notifications as read',
  security: bearer,
  responses: { 200: ok(z.object({ updated: z.number() })) },
});
