import type { RequestHandler } from 'express';

import { ok } from '../../shared/http/envelope';

import { PERMISSION_INFO, PERMISSIONS } from './permissions';
import { SYSTEM_ROLE_KEYS, SYSTEM_ROLES } from './system-roles';

const catalog = {
  permissions: PERMISSIONS.map((key) => ({ key, ...PERMISSION_INFO[key] })),
  roles: SYSTEM_ROLE_KEYS.map((key) => ({ key, ...SYSTEM_ROLES[key] })),
};

/** GET /api/v1/rbac/permissions — the catalogue + built-in roles (frontend uses the same list). */
export const getCatalog: RequestHandler = (_req, res) => {
  ok(res, catalog);
};
