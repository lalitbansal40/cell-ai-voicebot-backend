import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';
import {
  AcceptedSchema,
  AuthSessionSchema,
  EmailSchema,
  PasswordInputSchema,
} from '../auth/auth.schema';

/** Roles a member can be given (the owner role only moves by ownership transfer). */
export const AssignableRoleSchema = z.enum(['admin', 'manager', 'agent', 'viewer']);

export const ListMembersQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  status: z.enum(['invited', 'active', 'disabled']).optional(),
  roleKey: z.enum(['owner', 'admin', 'manager', 'agent', 'viewer']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const InviteBody = z.strictObject({
  email: EmailSchema,
  name: z.string().trim().min(1).max(80),
  roleKey: AssignableRoleSchema,
});

export const UpdateMemberBody = z
  .strictObject({
    roleKey: AssignableRoleSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((b) => b.roleKey !== undefined || b.status !== undefined, 'Send roleKey and/or status');

export const TransferOwnershipBody = z.strictObject({
  userId: ObjectIdSchema,
  password: PasswordInputSchema,
});

export const IdParams = z.strictObject({ id: ObjectIdSchema });
export const UserIdParams = z.strictObject({ userId: ObjectIdSchema });

export const InviteTokenQuery = z.strictObject({ token: z.string().min(20).max(100) });

export const AcceptInviteBody = z.strictObject({
  token: z.string().min(20).max(100),
  password: PasswordInputSchema,
  name: z.string().trim().min(1).max(80).optional(),
});

export const TeamMemberSchema = registry.register(
  'TeamMember',
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    status: z.enum(['invited', 'active', 'disabled']),
    role: z.object({ key: z.string(), name: z.string() }),
    isOwner: z.boolean(),
    lastLoginAt: z.string().nullable(),
    inviteExpiresAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const InviteInfoSchema = registry.register(
  'InviteInfo',
  z.object({
    email: z.string(),
    name: z.string(),
    accountName: z.string(),
    inviterName: z.string(),
    roleName: z.string(),
  }),
);

const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const list = z.object({
  success: z.literal(true),
  data: z.array(TeamMemberSchema),
  meta: OffsetPageMetaSchema,
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/team/users',
  tags: ['Team'],
  summary: 'Team members + pending invites (team.read)',
  security: bearer,
  request: { query: ListMembersQuery },
  responses: {
    200: { description: 'Members', content: { 'application/json': { schema: list } } },
    401: errors[401],
    403: errors[403],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/team/invites',
  tags: ['Team'],
  summary: 'Invite a member by email (team.invite; only the owner can invite admins)',
  security: bearer,
  request: json(InviteBody),
  responses: {
    201: ok(TeamMemberSchema, 'Invited'),
    401: errors[401],
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/team/invites/{userId}/resend',
  tags: ['Team'],
  summary: 'Send the invitation again (new link, old one stops working; 60 s cooldown)',
  security: bearer,
  request: { params: UserIdParams },
  responses: {
    202: { description: 'Sent', content: { 'application/json': { schema: AcceptedSchema } } },
    404: errors[404],
    409: errors[409],
    429: errors[429],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/team/invites/{userId}',
  tags: ['Team'],
  summary: 'Revoke a pending invitation',
  security: bearer,
  request: { params: UserIdParams },
  responses: { 204: noContentResponse, 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/team/users/{id}',
  tags: ['Team'],
  summary: 'Change role and/or enable / disable a member (team.update)',
  security: bearer,
  request: { params: IdParams, ...json(UpdateMemberBody) },
  responses: {
    200: ok(TeamMemberSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/team/users/{id}',
  tags: ['Team'],
  summary: 'Remove a member (team.remove) — their sessions end',
  security: bearer,
  request: { params: IdParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/team/transfer-ownership',
  tags: ['Team'],
  summary: 'Owner only: make an active admin the owner (you become admin); needs your password',
  security: bearer,
  request: json(TransferOwnershipBody),
  responses: {
    200: ok(z.object({ ownerId: z.string() })),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/invite-info',
  tags: ['Auth'],
  summary: 'Details of a pending invitation (for the accept page)',
  request: { query: InviteTokenQuery },
  responses: { 200: ok(InviteInfoSchema), 422: errors[422], 429: errors[429] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/accept-invite',
  tags: ['Auth'],
  summary: 'Accept an invitation: set a password and sign in',
  request: json(AcceptInviteBody),
  responses: {
    200: ok(AuthSessionSchema, 'Signed in (sets the cav_rt cookie)'),
    422: errors[422],
    429: errors[429],
  },
});
