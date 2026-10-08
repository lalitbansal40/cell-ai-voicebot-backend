import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import { AuditEntrySchema } from '../audit/audit.schema';
import { AuthSessionSchema, PublicAccountSchema, PublicUserSchema } from '../auth/auth.schema';

export const ListAccountsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  status: z.enum(['active', 'suspended']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const AccountIdParams = z.strictObject({ id: ObjectIdSchema });
export const SuspendBody = z.strictObject({ reason: z.string().trim().min(3).max(200) });

export const AdminAccountRowSchema = registry.register(
  'AdminAccountRow',
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['active', 'suspended']),
    ownerEmail: z.string().nullable(),
    usersCount: z.number().int(),
    createdAt: z.string(),
  }),
);

export const AdminAccountDetailSchema = registry.register(
  'AdminAccountDetail',
  z.object({
    account: PublicAccountSchema,
    owner: PublicUserSchema.nullable(),
    usersCount: z.number().int(),
    usersByStatus: z.object({ invited: z.number(), active: z.number(), disabled: z.number() }),
    recentAudit: z.array(AuditEntrySchema),
  }),
);

const tags = ['Superadmin'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts',
  tags,
  summary: 'All customer accounts (superadmin)',
  security: bearer,
  request: { query: ListAccountsQuery },
  responses: {
    200: {
      description: 'Accounts',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(AdminAccountRowSchema),
            meta: OffsetPageMetaSchema,
          }),
        },
      },
    },
    401: errors[401],
    403: errors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts/{id}',
  tags,
  summary: 'Account detail with owner, user counts and recent audit (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(AdminAccountDetailSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/suspend',
  tags,
  summary: 'Suspend an account — it becomes read-only (superadmin)',
  security: bearer,
  request: { params: AccountIdParams, ...json(SuspendBody) },
  responses: { 200: ok(PublicAccountSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/enable',
  tags,
  summary: 'Re-enable a suspended account (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(PublicAccountSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/impersonate',
  tags,
  summary: 'View as the account owner for 30 minutes (no refresh cookie; audited)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(AuthSessionSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/impersonation/stop',
  tags,
  summary: 'End an impersonation session (call with the impersonation token)',
  security: bearer,
  responses: { 204: noContentResponse, 401: errors[401], 409: errors[409] },
});
