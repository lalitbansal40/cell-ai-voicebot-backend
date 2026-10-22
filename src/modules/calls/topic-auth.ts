import { Types } from 'mongoose';

import type { AuthorizeTopic } from '../../core/realtime/topics';
import { CallModel } from '../../db/models/call.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { ConversationModel } from '../../db/models/conversation.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';

const PERMISSION = {
  call: 'calls.read',
  campaign: 'campaigns.read',
  conversation: 'inbox.read',
} as const;

const exists = (kind: 'call' | 'campaign' | 'conversation', id: string, accountId: string) => {
  if (kind === 'call') return CallModel.exists({ _id: id, accountId });
  if (kind === 'campaign') return CampaignModel.exists({ _id: id, accountId, deletedAt: null });
  return ConversationModel.exists({ _id: id, accountId });
};

/**
 * `call:<id>` / `campaign:<id>` / `conversation:<id>` — only for a call / campaign /
 * WhatsApp conversation of the socket's account, by a user whose role has
 * `calls.read` / `campaigns.read` / `inbox.read` (or a superadmin viewing the account).
 * Conversation topics carry message text — account events never do.
 */
export const authorizeTopic: AuthorizeTopic = async (ctx, topic) => {
  if (!(topic.kind in PERMISSION)) return false;
  if (!Types.ObjectId.isValid(ctx.accountId) || !Types.ObjectId.isValid(ctx.userId)) return false;
  if (!Types.ObjectId.isValid(topic.id)) return false;
  if (!(await exists(topic.kind, topic.id, ctx.accountId))) return false;
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
  return Boolean(role?.permissions.includes(PERMISSION[topic.kind]));
};
