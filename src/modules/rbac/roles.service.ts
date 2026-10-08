import type { ClientSession, Types } from 'mongoose';

import { AccountModel } from '../../db/models/account.model';
import { RoleModel } from '../../db/models/role.model';

import { SYSTEM_ROLE_KEYS, SYSTEM_ROLES, type SystemRoleKey } from './system-roles';

/**
 * Upserts the 5 system roles of an account with the current `SYSTEM_ROLES`
 * permissions (idempotent). Used at signup and by migrations whenever the
 * role matrix changes.
 */
export const syncSystemRoles = async (
  accountId: Types.ObjectId,
  session?: ClientSession,
): Promise<Record<SystemRoleKey, Types.ObjectId>> => {
  await RoleModel.bulkWrite(
    SYSTEM_ROLE_KEYS.map((key) => ({
      updateOne: {
        filter: { accountId, key },
        update: {
          $set: {
            name: SYSTEM_ROLES[key].name,
            permissions: SYSTEM_ROLES[key].permissions,
            isSystem: true,
          },
          $setOnInsert: { accountId, key },
        },
        upsert: true,
      },
    })),
    { session },
  );
  const roles = await RoleModel.find({ accountId, key: { $in: SYSTEM_ROLE_KEYS } })
    .select({ key: 1 })
    .session(session ?? null)
    .lean();
  return Object.fromEntries(roles.map((r) => [r.key, r._id])) as Record<
    SystemRoleKey,
    Types.ObjectId
  >;
};

/** Re-syncs system roles for every non-platform account. Returns the number of accounts. */
export const syncAllSystemRoles = async (): Promise<number> => {
  const accounts = await AccountModel.find({ isPlatform: { $ne: true } })
    .select({ _id: 1 })
    .lean();
  for (const { _id } of accounts) await syncSystemRoles(_id);
  return accounts.length;
};
