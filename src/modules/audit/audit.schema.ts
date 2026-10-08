import { CursorPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { CursorQuerySchema, ObjectIdSchema } from '../../shared/validation/schemas';

import { AUDIT_ACTIONS } from './audit-actions';

export const ListAuditQuery = z
  .strictObject({
    ...CursorQuerySchema.shape,
    actorId: ObjectIdSchema.optional(),
    /** Exact action or a prefix ending in `.*` (e.g. `team.*`). */
    action: z
      .string()
      .regex(/^[a-z_]+(\.[a-z_]+|\.\*)$/, 'Use an action like team.invited or a prefix like team.*')
      .optional(),
    targetType: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(40)
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must be before to',
    path: ['to'],
  });

export const AuditEntrySchema = registry.register(
  'AuditEntry',
  z.object({
    id: z.string(),
    action: z.enum(AUDIT_ACTIONS),
    actor: z.object({
      type: z.enum(['user', 'api_key', 'system']),
      id: z.string().nullable(),
      name: z.string().nullable(),
      impersonatorId: z.string().nullable(),
      platform: z.boolean(),
    }),
    target: z.object({ type: z.string(), id: z.string().nullable() }).nullable(),
    meta: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    at: z.string(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/audit-logs',
  tags: ['Audit'],
  summary: 'Audit log of the account, newest first (audit.read, cursor pagination)',
  security: bearer,
  request: { query: ListAuditQuery },
  responses: {
    200: {
      description: 'Entries',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(AuditEntrySchema),
            meta: CursorPageMetaSchema,
          }),
        },
      },
    },
    401: errors[401],
    403: errors[403],
    422: errors[422],
  },
});
