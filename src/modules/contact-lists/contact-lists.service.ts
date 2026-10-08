import type { Request } from 'express';
import type { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import {
  ContactListModel,
  type ContactListDoc,
  type ListSourceType,
} from '../../db/models/contact-list.model';
import { ContactModel } from '../../db/models/contact.model';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { escapeRegex } from '../../shared/utils/regex';
import { auditRequest } from '../audit/audit.service';
import type { ContactJobs } from '../contacts/jobs';

export const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface PublicContactList {
  id: string;
  name: string;
  description: string | null;
  source: { type: ListSourceType; fileName: string | null };
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

export const toPublicList = (l: ContactListDoc, contactCount: number): PublicContactList => ({
  id: l._id.toString(),
  name: l.name,
  description: l.description ?? null,
  source: { type: l.source.type, fileName: l.source.fileName ?? null },
  contactCount,
  createdAt: l.createdAt.toISOString(),
  updatedAt: l.updatedAt.toISOString(),
});

/** Live contacts per list, one aggregation for a page of lists. */
export const countMembers = async (
  accountId: Types.ObjectId,
  listIds: Types.ObjectId[],
): Promise<Map<string, number>> => {
  if (!listIds.length) return new Map();
  const rows = await ContactModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { accountId, deletedAt: null, listIds: { $in: listIds } } },
    { $unwind: '$listIds' },
    { $match: { listIds: { $in: listIds } } },
    { $group: { _id: '$listIds', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
};

const sameName = (accountId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) =>
  ContactListModel.findOne({ accountId, name, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .collation(NAME_COLLATION)
    .select({ _id: 1 })
    .lean();

const duplicateName = (existingId: string) =>
  new ConflictError('CONFLICT_DUPLICATE', 'A list with this name already exists.', [
    { path: 'name', message: 'Already exists', existingId },
  ]);

const findList = async (req: Request, id: string): Promise<ContactListDoc> => {
  const _id = toObjectId(id);
  const list = _id
    ? await ContactListModel.findOne({ _id, ...tenantFilter(req) }).lean<ContactListDoc>()
    : null;
  if (!list) throw new NotFoundError('List not found');
  return list;
};

export const listLists = async (req: Request, q: { page: number; limit: number; q?: string }) => {
  const { accountId } = tenantFilter(req);
  const filter: Record<string, unknown> = { accountId };
  if (q.q) filter.name = { $regex: escapeRegex(q.q), $options: 'i' };
  const [lists, total] = await Promise.all([
    ContactListModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<ContactListDoc[]>(),
    ContactListModel.countDocuments(filter),
  ]);
  const counts = await countMembers(
    accountId,
    lists.map((l) => l._id),
  );
  return {
    items: lists.map((l) => toPublicList(l, counts.get(l._id.toString()) ?? 0)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

export const getList = async (req: Request, id: string): Promise<PublicContactList> => {
  const list = await findList(req, id);
  const counts = await countMembers(list.accountId, [list._id]);
  return toPublicList(list, counts.get(list._id.toString()) ?? 0);
};

/** Creates a list (also used by imports with `source.type = upload`). */
export const createListDoc = async (
  accountId: Types.ObjectId,
  input: {
    name: string;
    description?: string | null;
    source: { type: ListSourceType; fileName?: string | null };
  },
): Promise<ContactListDoc> => {
  const existing = await sameName(accountId, input.name);
  if (existing) throw duplicateName(existing._id.toString());
  if ((await ContactListModel.countDocuments({ accountId })) >= CONTACT_LIMITS.listsPerAccount) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${CONTACT_LIMITS.listsPerAccount} lists.`,
    );
  }
  try {
    const doc = await ContactListModel.create({
      accountId,
      name: input.name,
      description: input.description ?? null,
      source: { type: input.source.type, fileName: input.source.fileName ?? null },
    });
    return doc.toObject({ transform: false });
  } catch (err) {
    if (isDuplicateKeyError(err))
      throw new ConflictError('CONFLICT_DUPLICATE', 'A list with this name already exists.');
    throw err;
  }
};

export const createList = async (
  req: Request,
  body: { name: string; description?: string | null },
): Promise<PublicContactList> =>
  toPublicList(
    await createListDoc(tenantFilter(req).accountId, { ...body, source: { type: 'manual' } }),
    0,
  );

export const updateList = async (
  req: Request,
  id: string,
  body: { name?: string; description?: string | null },
): Promise<PublicContactList> => {
  const list = await findList(req, id);
  if (body.name !== undefined) {
    const existing = await sameName(list.accountId, body.name, list._id);
    if (existing) throw duplicateName(existing._id.toString());
  }
  try {
    const updated = await ContactListModel.findOneAndUpdate(
      { _id: list._id, accountId: list.accountId },
      {
        $set: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
        },
      },
      { new: true },
    ).lean<ContactListDoc>();
    if (!updated) throw new NotFoundError('List not found');
    const counts = await countMembers(list.accountId, [list._id]);
    return toPublicList(updated, counts.get(list._id.toString()) ?? 0);
  } catch (err) {
    if (isDuplicateKeyError(err))
      throw new ConflictError('CONFLICT_DUPLICATE', 'A list with this name already exists.');
    throw err;
  }
};

export const deleteList = async (req: Request, id: string, jobs: ContactJobs): Promise<void> => {
  const list = await findList(req, id);
  await ContactListModel.updateOne(
    { _id: list._id, accountId: list.accountId },
    { $set: { deletedAt: new Date() } },
  );
  await jobs.enqueue('list.delete_members', {
    accountId: list.accountId.toString(),
    listId: list._id.toString(),
  });
  await auditRequest(req, 'contact_list.deleted', {
    target: { type: 'contact_list', id: list._id.toString() },
    meta: { name: list.name },
  });
};
