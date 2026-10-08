import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

export const PermissionInfoSchema = z.object({
  key: z.string().openapi({ example: 'team.invite' }),
  group: z.string().openapi({ example: 'Team' }),
  description: z.string(),
});

export const SystemRoleSchema = z.object({
  key: z.enum(['owner', 'admin', 'manager', 'agent', 'viewer']),
  name: z.string(),
  permissions: z.array(z.string()),
});

/** `GET /api/v1/rbac/permissions` — the catalogue + built-in roles. */
export const RbacCatalogSchema = registry.register(
  'RbacCatalog',
  z.object({ permissions: z.array(PermissionInfoSchema), roles: z.array(SystemRoleSchema) }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/rbac/permissions',
  tags: ['RBAC'],
  summary: 'Permission catalogue and built-in roles',
  security: bearer,
  responses: { 200: ok(RbacCatalogSchema), 401: errors[401] },
});
