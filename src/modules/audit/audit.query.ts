import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { AuditLogModel, type AuditLogDoc } from '../../db/models/audit-log.model';
import { UserModel } from '../../db/models/user.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor';

import type { ListAuditQuery } from './audit.schema';

/** Newest first; cursor = `{ at, id }` of the last item. */
export const listAudit = async (req: Request, query: z.infer<typeof ListAuditQuery>) => {
  const filter: Record<string, unknown> = { ...tenantFilter(req) };
  if (query.actorId) filter['actor.id'] = new Types.ObjectId(query.actorId);
  if (query.action) {
    filter.action = query.action.endsWith('.*')
      ? { $regex: `^${query.action.slice(0, -2)}\\.` }
      : query.action;
  }
  if (query.targetType) filter['target.type'] = query.targetType;
  const at: Record<string, Date> = {};
  if (query.from) at.$gte = new Date(query.from);
  if (query.to) at.$lte = new Date(query.to);
  if (Object.keys(at).length) filter.at = at;
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const cAt = new Date(c.at);
    filter.$or = [{ at: { $lt: cAt } }, { at: cAt, _id: { $lt: new Types.ObjectId(c.id) } }];
  }

  const rows = await AuditLogModel.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<AuditLogDoc[]>();
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);

  const userIds = [
    ...new Set(
      page.filter((r) => r.actor.type === 'user' && r.actor.id).map((r) => String(r.actor.id)),
    ),
  ];
  const users = await UserModel.find({ _id: { $in: userIds } })
    .setOptions({ withDeleted: true })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const names = new Map(users.map((u) => [u._id.toString(), u.name]));

  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r._id.toString(),
      action: r.action,
      actor: {
        type: r.actor.type,
        id: r.actor.id ? r.actor.id.toString() : null,
        name: r.actor.id ? (names.get(r.actor.id.toString()) ?? null) : null,
        impersonatorId: r.actor.impersonatorId ? r.actor.impersonatorId.toString() : null,
        platform: r.actor.platform ?? false,
      },
      target: r.target ? { type: r.target.type, id: r.target.id ?? null } : null,
      meta: r.meta ?? null,
      ip: r.ip ?? null,
      at: r.at.toISOString(),
    })),
    meta: {
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.at.toISOString(), id: last._id.toString() })
          : null,
    },
  };
};
