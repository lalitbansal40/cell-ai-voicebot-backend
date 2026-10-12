import { Types } from 'mongoose';

import type { AuthorizeTopic } from '../../core/realtime/topics';
import { CallModel } from '../../db/models/call.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';

/**
 * `call:<id>` — only for a call of the socket's account, by a user whose role has
 * `calls.read` (or a superadmin viewing the account). `campaign:<id>` arrives in Phase 8.
 */
export const authorizeTopic: AuthorizeTopic = async (ctx, topic) => {
  if (topic.kind !== 'call') return false;
  if (!Types.ObjectId.isValid(ctx.accountId) || !Types.ObjectId.isValid(ctx.userId)) return false;
  const call = await CallModel.exists({ _id: topic.id, accountId: ctx.accountId });
  if (!call) return false;
  const user = await UserModel.findById(ctx.userId)
    .select({ accountId: 1, roleId: 1, platformRole: 1, status: 1 })
    .lean<{
      accountId: Types.ObjectId;
      roleId: Types.ObjectId | null;
      platformRole?: string | null;
      status: string;
    }>();
  if (!user || user.status !== 'active') return false;
  if (!user.accountId.equals(ctx.accountId)) return user.platformRole === 'superadmin';
  const role = await RoleModel.findById(user.roleId).select({ permissions: 1 }).lean();
  return Boolean(role?.permissions.includes('calls.read'));
};
