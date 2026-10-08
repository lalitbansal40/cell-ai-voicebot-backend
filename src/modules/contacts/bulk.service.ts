import { randomUUID } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { CONTACT_LIMITS } from '../../config/limits';
import { notifyAccount } from '../../core/realtime/notify';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel } from '../../db/models/contact.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';
import { addDndEntries } from '../dnd/dnd.service';

import type { BulkAction, BulkBody } from './bulk.schema';
import { compileContext, loadContactContext } from './context';
import { compileOrThrow } from './filter/compile';
import type { ContactFilter } from './filter/filter.schema';
import type { ContactJobData, ContactJobs } from './jobs';
import { acquireJobLock, releaseJobLock } from './locks';
import { normalizeTags } from './normalize';

export interface BulkPayload {
  tags?: string[];
  listId?: string;
  reason?: string;
}

/** Applies one action to the contacts matched by `query`; returns how many changed. */
export const applyBulk = async (
  accountId: Types.ObjectId,
  query: Record<string, unknown>,
  action: BulkAction,
  payload: BulkPayload,
  addedBy: Types.ObjectId | null,
): Promise<number> => {
  const scoped = { ...query, accountId, deletedAt: null };
  switch (action) {
    case 'add_tags': {
      const tags = (normalizeTags(payload.tags ?? []) as { tags: string[] }).tags;
      // Contacts that would go past 20 tags (or already have them all) are skipped, never truncated.
      const union = { $setUnion: ['$tags', tags] };
      const r = await ContactModel.updateMany(
        {
          ...scoped,
          tags: { $not: { $all: tags } },
          $expr: { $lte: [{ $size: union }, CONTACT_LIMITS.tagsPerContact] },
        },
        [{ $set: { tags: union } }],
        { updatePipeline: true },
      );
      return r.modifiedCount;
    }
    // Filters below match only contacts that really change: timestamps make
    // every matched document count as "modified".
    case 'remove_tags': {
      const tags = (normalizeTags(payload.tags ?? []) as { tags: string[] }).tags;
      const r = await ContactModel.updateMany(
        { ...scoped, tags: { $in: tags } },
        { $pull: { tags: { $in: tags } } },
      );
      return r.modifiedCount;
    }
    case 'add_to_list': {
      const listId = new Types.ObjectId(payload.listId);
      const r = await ContactModel.updateMany(
        {
          ...scoped,
          listIds: { $ne: listId },
          // fewer than 50 lists ⇔ there is no element at index 49
          [`listIds.${CONTACT_LIMITS.listsPerContact - 1}`]: { $exists: false },
        },
        { $addToSet: { listIds: listId } },
      );
      return r.modifiedCount;
    }
    case 'remove_from_list': {
      const listId = new Types.ObjectId(payload.listId);
      const r = await ContactModel.updateMany(
        { ...scoped, listIds: listId },
        { $pull: { listIds: listId } },
      );
      return r.modifiedCount;
    }
    case 'delete':
      return (await ContactModel.updateMany(scoped, { $set: { deletedAt: new Date() } }))
        .modifiedCount;
    case 'add_to_dnd': {
      const phones = await ContactModel.find(scoped)
        .select({ phoneE164: 1 })
        .lean<{ phoneE164: string }[]>();
      await addDndEntries(
        accountId,
        phones.map((p) => ({ phoneE164: p.phoneE164, reason: payload.reason ?? null })),
        'manual',
        addedBy,
      );
      return phones.length;
    }
  }
};

const auditBulk = async (
  accountId: Types.ObjectId,
  actor: AuditActorInput,
  action: BulkAction,
  count: number,
  mode: 'ids' | 'filter',
  ip: string | null,
) => {
  if (action === 'delete') {
    await recordAudit({ accountId, actor, action: 'contacts.deleted', meta: { count, mode }, ip });
  } else if (action === 'add_to_dnd') {
    await recordAudit({
      accountId,
      actor,
      action: 'dnd.added',
      meta: { count, source: 'manual' },
      ip,
    });
  } else {
    await recordAudit({
      accountId,
      actor,
      action: 'contacts.bulk_updated',
      meta: { action, count, mode },
      ip,
    });
  }
};

const assertList = async (accountId: Types.ObjectId, action: BulkAction, payload: BulkPayload) => {
  if (action !== 'add_to_list' && action !== 'remove_from_list') return;
  const exists = await ContactListModel.exists({
    _id: new Types.ObjectId(payload.listId),
    accountId,
  });
  if (!exists) throw new ValidationError([{ path: 'payload.listId', message: 'Unknown list' }]);
};

const assertTags = (action: BulkAction, payload: BulkPayload) => {
  if (
    (action === 'add_tags' || action === 'remove_tags') &&
    !normalizeTags(payload.tags ?? []).ok
  ) {
    throw new ValidationError([{ path: 'payload.tags', message: 'Invalid tag' }]);
  }
};

export const runBulk = async (
  req: Request,
  body: z.infer<typeof BulkBody>,
  jobs: ContactJobs,
): Promise<{ count: number; jobQueued?: true }> => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  const payload = body.payload;
  assertTags(body.action, payload);
  await assertList(accountId, body.action, payload);
  const actor: AuditActorInput = {
    type: 'user',
    id: auth.userId,
    impersonatorId: auth.impersonatorId,
  };
  const userId = new Types.ObjectId(auth.userId);

  if (body.ids) {
    const ids = [...new Set(body.ids)].map((id) => new Types.ObjectId(id));
    const found = await ContactModel.countDocuments({ accountId, _id: { $in: ids } });
    if (found !== ids.length) throw new NotFoundError('Some contacts were not found');
    const count = await applyBulk(accountId, { _id: { $in: ids } }, body.action, payload, userId);
    await auditBulk(accountId, actor, body.action, count, 'ids', req.ip ?? null);
    notifyAccount(accountId.toString(), 'contacts.changed', {
      reason: body.action === 'add_to_dnd' ? 'dnd' : 'bulk',
    });
    return { count };
  }

  const ctx = await loadContactContext(accountId);
  const query = compileOrThrow(accountId, body.filter as ContactFilter, compileContext(ctx));
  const count = await ContactModel.countDocuments(query);
  if (count > CONTACT_LIMITS.bulkFilterMax) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `This filter matches ${count} contacts — narrow it to at most ${CONTACT_LIMITS.bulkFilterMax}.`,
    );
  }
  const owner = randomUUID();
  if (!(await acquireJobLock('bulk', accountId.toString(), owner))) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Another bulk action is running — wait for it to finish.',
    );
  }
  try {
    await jobs.enqueue('bulk.run', {
      accountId: accountId.toString(),
      actorUserId: auth.userId ?? '',
      ...(auth.impersonatorId ? { impersonatorId: auth.impersonatorId } : {}),
      action: body.action,
      filter: body.filter as Record<string, unknown>,
      payload: { ...payload, lockOwner: owner },
    });
  } catch (err) {
    await releaseJobLock('bulk', accountId.toString(), owner);
    throw err;
  }
  return { count, jobQueued: true };
};

/** `bulk.run` — a filter-based bulk action, in batches of 1,000 contact ids. */
export const bulkJob = async (data: ContactJobData['bulk.run']): Promise<{ count: number }> => {
  const accountId = new Types.ObjectId(data.accountId);
  const payload = data.payload as BulkPayload & { lockOwner?: string };
  const action = data.action as BulkAction;
  try {
    const ctx = await loadContactContext(accountId);
    // A filter that no longer compiles (field deleted meanwhile) matches nothing.
    let query: Record<string, unknown>;
    try {
      query = compileOrThrow(accountId, data.filter, compileContext(ctx));
    } catch {
      query = { _id: { $in: [] } };
    }
    const ids = (
      await ContactModel.find(query).select({ _id: 1 }).limit(CONTACT_LIMITS.bulkFilterMax).lean()
    ).map((c) => c._id);
    let count = 0;
    for (let i = 0; i < ids.length; i += CONTACT_LIMITS.exportBatchSize) {
      const batch = ids.slice(i, i + CONTACT_LIMITS.exportBatchSize);
      count += await applyBulk(
        accountId,
        { _id: { $in: batch } },
        action,
        payload,
        new Types.ObjectId(data.actorUserId),
      );
    }
    const actor: AuditActorInput = {
      type: 'user',
      id: data.actorUserId,
      impersonatorId: data.impersonatorId,
    };
    await auditBulk(accountId, actor, action, count, 'filter', null);
    notifyAccount(data.accountId, 'contacts.bulk_completed', { action, count });
    notifyAccount(data.accountId, 'contacts.changed', {
      reason: action === 'add_to_dnd' ? 'dnd' : 'bulk',
    });
    return { count };
  } finally {
    if (payload.lockOwner) await releaseJobLock('bulk', data.accountId, payload.lockOwner);
  }
};
