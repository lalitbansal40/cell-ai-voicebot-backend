import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';

/** Phase 3: adds `dnd.manage` to the owner / admin system roles of every account. */
export const dndManagePermission: Migration = {
  name: '0004-dnd-manage-permission',
  up: async () => {
    await syncAllSystemRoles();
  },
  down: async (db) => {
    await db
      .collection('roles')
      .updateMany({ isSystem: true }, { $pull: { permissions: 'dnd.manage' } } as never);
  },
};
