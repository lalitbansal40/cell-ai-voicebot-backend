import { Types } from 'mongoose';

import type { AuthorizeTopic } from '../../core/realtime/topics';
import { CallModel } from '../../db/models/call.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';

/**
 * `call:<id>` / `campaign:<id>` — only for a call / campaign of the socket's
 * account, by a user whose role has `calls.read` / `campaigns.read` (or a
 * superadmin viewing the account).
 */
export const authorizeTopic: AuthorizeTopic = async (ctx, topic) => {
  if (topic.kind !== 'call' && topic.kind !== 'campaign') return false;
  if (!Types.ObjectId.isValid(ctx.accountId) || !Types.ObjectId.isValid(ctx.userId)) return false;
  if (!Types.ObjectId.isValid(topic.id)) return false;
  const exists =
    topic.kind === 'call'
      ? await CallModel.exists({ _id: topic.id, accountId: ctx.accountId })
      : await CampaignModel.exists({ _id: topic.id, accountId: ctx.accountId, deletedAt: null });
  if (!exists) return false;
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
  return Boolean(
    role?.permissions.includes(topic.kind === 'call' ? 'calls.read' : 'campaigns.read'),
  );
};
