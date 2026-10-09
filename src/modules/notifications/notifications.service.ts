import { Types } from 'mongoose';
import type { z } from 'zod';

import { notifyUser } from '../../core/realtime/notify';
import { AccountModel } from '../../db/models/account.model';
import {
  NOTIFICATION_TTL_MS,
  NotificationModel,
  type NotificationDoc,
  type NotificationType,
} from '../../db/models/notification.model';
import { RoleModel } from '../../db/models/role.model';
import { UserModel } from '../../db/models/user.model';
import { NotFoundError } from '../../shared/errors/app-error';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor';
import { getLogger } from '../../shared/logger';

import type { ListNotificationsQuery } from './notifications.schema';

export interface Recipient {
  userId: Types.ObjectId;
  email: string;
  name: string;
}

/** Active users of the account whose role grants `permission`. */
export const usersWithPermission = async (
  accountId: Types.ObjectId,
  permission: string,
): Promise<Recipient[]> => {
  const roles = await RoleModel.find({ accountId, permissions: permission })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  if (!roles.length) return [];
  const users = await UserModel.find({
    accountId,
    roleId: { $in: roles.map((r) => r._id) },
    status: 'active',
  })
    .select({ email: 1, name: 1 })
    .lean<{ _id: Types.ObjectId; email: string; name: string }[]>();
  return users.map((u) => ({ userId: u._id, email: u.email, name: u.name }));
};

/** Active superadmins (recipients of platform notifications). */
export const superadmins = async (): Promise<{ accountId: Types.ObjectId; users: Recipient[] }> => {
  const platform = await AccountModel.findOne({ isPlatform: true })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (!platform) return { accountId: new Types.ObjectId(), users: [] };
  const users = await UserModel.find({
    accountId: platform._id,
    platformRole: 'superadmin',
    status: 'active',
  })
    .select({ email: 1, name: 1 })
    .lean<{ _id: Types.ObjectId; email: string; name: string }[]>();
  return {
    accountId: platform._id,
    users: users.map((u) => ({ userId: u._id, email: u.email, name: u.name })),
  };
};

export interface NotifyInput {
  accountId: Types.ObjectId;
  /** Explicit recipients, or everyone in the account with `permission`. */
  userIds?: Types.ObjectId[];
  permission?: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
}

/**
 * Creates one notification row per recipient (each has its own read state)
 * and pushes `notification.created` to them. Never throws.
 */
export const notify = async (input: NotifyInput): Promise<number> => {
  try {
    const userIds =
      input.userIds ??
      (input.permission
        ? (await usersWithPermission(input.accountId, input.permission)).map((r) => r.userId)
        : []);
    if (!userIds.length) return 0;
    const expiresAt = new Date(Date.now() + NOTIFICATION_TTL_MS);
    const docs = await NotificationModel.insertMany(
      userIds.map((userId) => ({
        accountId: input.accountId,
        userId,
        type: input.type,
        title: input.title.slice(0, 120),
        body: input.body.slice(0, 500),
        link: input.link ?? null,
        expiresAt,
      })),
    );
    for (const d of docs) {
      notifyUser(d.accountId.toString(), d.userId.toString(), 'notification.created', {
        notificationId: d._id.toString(),
        title: d.title,
      });
    }
    return docs.length;
  } catch (err) {
    getLogger().error({ err, type: input.type }, 'notifications: create failed');
    return 0;
  }
};

/** Notification for every active superadmin (lives in the platform account). */
export const notifyPlatform = async (
  input: Omit<NotifyInput, 'accountId' | 'userIds' | 'permission'>,
): Promise<number> => {
  const { accountId, users } = await superadmins();
  return notify({ ...input, accountId, userIds: users.map((u) => u.userId) });
};

const view = (n: NotificationDoc) => ({
  id: n._id.toString(),
  type: n.type,
  title: n.title,
  body: n.body,
  link: n.link ?? null,
  readAt: n.readAt ? n.readAt.toISOString() : null,
  createdAt: n.createdAt.toISOString(),
});

const scope = (accountId: Types.ObjectId, userId: Types.ObjectId) => ({ accountId, userId });

export const listNotifications = async (
  accountId: Types.ObjectId,
  userId: Types.ObjectId,
  query: z.infer<typeof ListNotificationsQuery>,
) => {
  const filter: Record<string, unknown> = scope(accountId, userId);
  if (query.unread) filter.readAt = null;
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const at = new Date(c.at);
    filter.$or = [
      { createdAt: { $lt: at } },
      { createdAt: at, _id: { $lt: new Types.ObjectId(c.id) } },
    ];
  }
  const rows = await NotificationModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<NotificationDoc[]>();
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(view),
    meta: {
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last._id.toString() })
          : null,
    },
  };
};

export const unreadCount = async (accountId: Types.ObjectId, userId: Types.ObjectId) =>
  NotificationModel.countDocuments({ ...scope(accountId, userId), readAt: null });

export const markRead = async (accountId: Types.ObjectId, userId: Types.ObjectId, id: string) => {
  const doc = await NotificationModel.findOneAndUpdate(
    { _id: id, ...scope(accountId, userId) },
    [{ $set: { readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
    { returnDocument: 'after', updatePipeline: true } as never,
  ).lean<NotificationDoc>();
  if (!doc) throw new NotFoundError('Notification not found');
  return view(doc);
};

export const markAllRead = async (accountId: Types.ObjectId, userId: Types.ObjectId) => {
  const res = await NotificationModel.updateMany(
    { ...scope(accountId, userId), readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { updated: res.modifiedCount };
};

/** Batch delete of expired rows (the TTL index also removes them — this keeps counts in logs). */
export const purgeNotifications = async (): Promise<{ deleted: number }> => {
  const res = await NotificationModel.deleteMany({ expiresAt: { $lt: new Date() } });
  return { deleted: res.deletedCount };
};
