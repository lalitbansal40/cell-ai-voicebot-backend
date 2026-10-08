import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';

/**
 * Upserts the 5 system roles for every account from `SYSTEM_ROLES`.
 * Whenever the role matrix changes, add a NEW migration that calls
 * `syncAllSystemRoles()` again (applied migrations never re-run).
 */
export const syncSystemRolesMigration: Migration = {
  name: '0003-sync-system-roles',
  up: async () => {
    await syncAllSystemRoles();
  },
  down: async () => {
    // Roles stay: users reference them. Nothing to undo safely.
  },
};
