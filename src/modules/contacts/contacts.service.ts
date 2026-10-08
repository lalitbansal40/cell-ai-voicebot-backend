import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { isDuplicateKeyError } from '../../db/errors';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel, type ContactDoc, type VariableValue } from '../../db/models/contact.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import { SegmentModel } from '../../db/models/segment.model';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import type { SortField } from '../../shared/validation/schemas';
import { auditRequest } from '../audit/audit.service';

import type {
  CONTACT_SORT_FIELDS,
  CreateContactBody,
  ListContactsQuery,
  UpdateContactBody,
} from './contacts.schema';
import { compileContext, loadContactContext, type ContactContext } from './context';
import { compileContactFilter, compileOrThrow } from './filter/compile';
import type { ContactFilter } from './filter/filter.schema';
import {
  applyDefaultsAndRequired,
  buildSearchText,
  normalizeEmail,
  normalizePhone,
  normalizeTags,
  parseFieldValue,
} from './normalize';

type SortFields = SortField<(typeof CONTACT_SORT_FIELDS)[number]>[];

export interface PublicContact {
  id: string;
  phoneE164: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  variables: Record<string, VariableValue>;
  tags: string[];
  listIds: string[];
  dnd: boolean;
  optedOutAt: string | null;
  consent: { source: string; at: string } | null;
  source: { type: 'manual' | 'import' | 'api'; importJobId: string | null };
  lastCalledAt: string | null;
  callCount: number;
  createdAt: string;
  updatedAt: string;
  lists?: { id: string; name: string }[];
}

const iso = (d?: Date | null): string | null => (d ? d.toISOString() : null);

const variablesObject = (v: ContactDoc['variables'] | Record<string, VariableValue> | undefined) =>
  v instanceof Map ? Object.fromEntries(v) : { ...(v ?? {}) };

export const toPublicContact = (c: ContactDoc): PublicContact => ({
  id: c._id.toString(),
  phoneE164: c.phoneE164,
  name: c.name ?? null,
  email: c.email ?? null,
  externalId: c.externalId ?? null,
  variables: variablesObject(c.variables),
  tags: [...c.tags],
  listIds: c.listIds.map((id) => id.toString()),
  dnd: c.dnd,
  optedOutAt: iso(c.optedOutAt),
  consent: c.consent ? { source: c.consent.source, at: c.consent.at.toISOString() } : null,
  source: {
    type: c.source.type,
    importJobId: c.source.importJobId ? c.source.importJobId.toString() : null,
  },
  lastCalledAt: iso(c.lastCalledAt),
  callCount: c.callCount,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const PHONE_MESSAGES: Record<string, string> = {
  phone_missing: 'Enter a phone number',
  phone_invalid: 'Not a valid phone number',
  phone_lost_digits: 'The number lost digits (scientific notation) — check it',
};

/** Mongo sort + whether the name collation is needed. */
export const toMongoSort = (
  sort: SortFields,
): { sort: Record<string, 1 | -1>; collation: boolean } => {
  const out: Record<string, 1 | -1> = {};
  for (const s of sort) out[s.field] = s.direction === 'asc' ? 1 : -1;
  out._id = out[sort[0]?.field ?? 'createdAt'] ?? -1;
  return { sort: out, collation: sort.some((s) => s.field === 'name') };
};

const pageOf = async (
  query: Record<string, unknown>,
  page: number,
  limit: number,
  sort: SortFields,
) => {
  const order = toMongoSort(sort);
  let find = ContactModel.find(query)
    .sort(order.sort)
    .skip((page - 1) * limit)
    .limit(limit);
  if (order.collation) find = find.collation({ locale: 'en', strength: 2 });
  const [items, total] = await Promise.all([
    find.lean<ContactDoc[]>(),
    ContactModel.countDocuments(query),
  ]);
  return {
    items: items.map(toPublicContact),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

/** `GET /contacts` query params → `ContactFilter` (+ optional saved segment). */
export const filterFromQuery = (q: z.infer<typeof ListContactsQuery>): ContactFilter => {
  if (q.tag && q.tagsAll) {
    throw new ValidationError([{ path: 'tagsAll', message: 'Use either tag or tagsAll' }]);
  }
  const tagValues = q.tag ?? q.tagsAll;
  return {
    ...(q.listId ? { listIds: [q.listId] } : {}),
    ...(tagValues?.length ? { tags: { mode: q.tagsAll ? 'all' : 'any', values: tagValues } } : {}),
    ...(q.dnd === undefined ? {} : { dnd: q.dnd }),
    ...(q.optedOut === undefined ? {} : { optedOut: q.optedOut }),
    ...(q.createdFrom ? { createdFrom: q.createdFrom } : {}),
    ...(q.createdTo ? { createdTo: q.createdTo } : {}),
    ...(q.q ? { q: q.q } : {}),
  };
};

/** A saved segment's query (bad conditions match nothing — PHASE_3_PLAN T3.5). */
export const segmentQuery = async (
  ctx: ContactContext,
  segmentId: string,
): Promise<Record<string, unknown>> => {
  const _id = toObjectId(segmentId);
  const segment = _id
    ? await SegmentModel.findOne({ _id, accountId: ctx.accountId }).lean<{
        filter: ContactFilter;
      }>()
    : null;
  if (!segment) throw new NotFoundError('Segment not found');
  return compileContactFilter(ctx.accountId, segment.filter, compileContext(ctx)).query;
};

export const listContacts = async (req: Request, q: z.infer<typeof ListContactsQuery>) => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  let query = compileOrThrow(ctx.accountId, filterFromQuery(q), compileContext(ctx), '');
  if (q.segmentId) query = { $and: [query, await segmentQuery(ctx, q.segmentId)] };
  return pageOf(query, q.page, q.limit, q.sort);
};

export const searchContacts = async (
  req: Request,
  body: { filter: ContactFilter; page: number; limit: number; sort: SortFields },
) => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  const query = compileOrThrow(ctx.accountId, body.filter, compileContext(ctx));
  return pageOf(query, body.page, body.limit, body.sort);
};

const findLive = async (req: Request, id: string): Promise<ContactDoc> => {
  const _id = toObjectId(id);
  const contact = _id
    ? await ContactModel.findOne({ _id, ...tenantFilter(req) }).lean<ContactDoc>()
    : null;
  if (!contact) throw new NotFoundError('Contact not found');
  return contact;
};

const listNames = async (accountId: Types.ObjectId, ids: Types.ObjectId[]) => {
  if (!ids.length) return [];
  const lists = await ContactListModel.find({ accountId, _id: { $in: ids } })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  return lists.map((l) => ({ id: l._id.toString(), name: l.name }));
};

export const getContact = async (req: Request, id: string): Promise<PublicContact> => {
  const contact = await findLive(req, id);
  return {
    ...toPublicContact(contact),
    lists: await listNames(contact.accountId, contact.listIds),
  };
};

/** All `ids` must be live lists of the account. */
export const assertOwnLists = async (
  accountId: Types.ObjectId,
  ids: string[],
  path = 'listIds',
) => {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const objectIds = unique.map((id) => new Types.ObjectId(id));
  const found = await ContactListModel.countDocuments({ accountId, _id: { $in: objectIds } });
  if (found !== unique.length) throw new ValidationError([{ path, message: 'Unknown list' }]);
  return objectIds;
};

type ContactInput = Partial<Omit<z.infer<typeof CreateContactBody>, 'phone'>> & { phone?: string };

interface NormalizedInput {
  phoneE164?: string;
  set: Record<string, unknown>;
  variables?: Record<string, VariableValue>;
}

/** Validates + normalises a create / update body; collects every error as 422 details. */
const normalizeInput = (
  ctx: ContactContext,
  body: ContactInput,
  current?: ContactDoc,
): NormalizedInput => {
  const errors: ErrorDetail[] = [];
  const set: Record<string, unknown> = {};
  let phoneE164: string | undefined;

  if (body.phone !== undefined) {
    const phone = normalizePhone(body.phone, ctx.country);
    if (phone.ok) phoneE164 = phone.e164;
    else errors.push({ path: 'phone', message: PHONE_MESSAGES[phone.reason] ?? 'Invalid phone' });
  }
  if (body.name !== undefined) set.name = body.name?.trim() || null;
  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (email.ok) set.email = email.value ?? null;
    else errors.push({ path: 'email', message: 'Not a valid e-mail address' });
  }
  if (body.externalId !== undefined) set.externalId = body.externalId?.trim() || null;
  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags.ok) set.tags = tags.tags;
    else
      errors.push({
        path: 'tags',
        message: 'Tags: letters, digits, space, _ or - (max 40 each, 20 total)',
      });
  }
  if (body.consent !== undefined) {
    set.consent = body.consent
      ? { source: body.consent.source, at: new Date(body.consent.at) }
      : null;
  }

  let variables: Record<string, VariableValue> | undefined;
  if (body.variables !== undefined || !current) {
    const merged: Record<string, VariableValue> = current ? variablesObject(current.variables) : {};
    for (const [key, raw] of Object.entries(body.variables ?? {})) {
      const field = ctx.byKey.get(key);
      if (!field) {
        errors.push({ path: `variables.${key}`, message: 'Unknown field' });
        continue;
      }
      if (raw === null) {
        delete merged[key];
        continue;
      }
      const parsed = parseFieldValue(field.type, raw, { country: ctx.country });
      if (!parsed.ok) {
        errors.push({
          path: `variables.${key}`,
          message:
            parsed.reason === 'too_long' ? 'Too long (max 1000)' : `Not a valid ${field.type}`,
        });
      } else if (parsed.value === undefined) {
        delete merged[key];
      } else {
        merged[key] = parsed.value;
      }
    }
    const checked = applyDefaultsAndRequired(ctx.fields, merged, { applyDefaults: !current });
    for (const key of checked.missing) {
      if (!errors.some((e) => e.path === `variables.${key}`)) {
        errors.push({ path: `variables.${key}`, message: 'Required' });
      }
    }
    variables = checked.variables;
  }

  if (errors.length) throw new ValidationError(errors);
  return { ...(phoneE164 ? { phoneE164 } : {}), set, ...(variables ? { variables } : {}) };
};

const duplicateError = (path: 'phone' | 'externalId', existingId: string) =>
  new ConflictError(
    'CONFLICT_DUPLICATE',
    path === 'phone'
      ? 'A contact with this phone number already exists.'
      : 'A contact with this external id already exists.',
    [{ path, message: 'Already exists', existingId }],
  );

const assertNoDuplicates = async (
  accountId: Types.ObjectId,
  { phoneE164, externalId }: { phoneE164?: string; externalId?: string | null },
  selfId?: Types.ObjectId,
) => {
  const notSelf = selfId ? { _id: { $ne: selfId } } : {};
  if (phoneE164) {
    const dup = await ContactModel.findOne({ accountId, phoneE164, ...notSelf })
      .select({ _id: 1 })
      .lean();
    if (dup) throw duplicateError('phone', dup._id.toString());
  }
  if (externalId) {
    const dup = await ContactModel.findOne({ accountId, externalId, ...notSelf })
      .select({ _id: 1 })
      .lean();
    if (dup) throw duplicateError('externalId', dup._id.toString());
  }
};

const isOnDnd = async (accountId: Types.ObjectId, phoneE164: string): Promise<boolean> =>
  Boolean(await DndEntryModel.exists({ accountId, phoneE164 }));

const rethrowDuplicate = (err: unknown): never => {
  if (isDuplicateKeyError(err)) {
    throw new ConflictError(
      'CONFLICT_DUPLICATE',
      'A contact with this phone number or external id already exists.',
    );
  }
  throw err;
};

export const createContact = async (
  req: Request,
  body: z.infer<typeof CreateContactBody>,
): Promise<PublicContact> => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  const input = normalizeInput(ctx, body);
  const phoneE164 = input.phoneE164 as string;
  const externalId = (input.set.externalId as string | null | undefined) ?? null;
  await assertNoDuplicates(ctx.accountId, { phoneE164, externalId });
  const listIds = await assertOwnLists(ctx.accountId, body.listIds ?? []);
  const fields = {
    name: null,
    email: null,
    externalId: null,
    tags: [],
    consent: null,
    ...input.set,
    phoneE164,
    variables: input.variables ?? {},
    listIds,
    dnd: await isOnDnd(ctx.accountId, phoneE164),
    optedOutAt: null,
    source: { type: 'manual' as const, importJobId: null },
    lastCalledAt: null,
    callCount: 0,
  };
  const searchText = buildSearchText({
    name: fields.name,
    email: fields.email,
    phoneE164,
    externalId: fields.externalId,
  });

  try {
    const deleted = await ContactModel.findOne({
      accountId: ctx.accountId,
      phoneE164,
      deletedAt: { $ne: null },
    })
      .sort({ deletedAt: -1 })
      .select({ _id: 1 })
      .lean();
    if (deleted) {
      const revived = await ContactModel.findOneAndUpdate(
        { _id: deleted._id, accountId: ctx.accountId, deletedAt: { $ne: null } },
        { $set: { ...fields, searchText, deletedAt: null } },
        { returnDocument: 'after' },
      ).lean<ContactDoc>();
      if (revived) return toPublicContact(revived);
    }
    const doc = await ContactModel.create({ accountId: ctx.accountId, ...fields, searchText });
    return toPublicContact(
      doc.toObject({ transform: false, flattenMaps: true }) as unknown as ContactDoc,
    );
  } catch (err) {
    return rethrowDuplicate(err);
  }
};

export const updateContact = async (
  req: Request,
  id: string,
  body: z.infer<typeof UpdateContactBody>,
): Promise<PublicContact> => {
  const current = await findLive(req, id);
  const ctx = await loadContactContext(current.accountId);
  const input = normalizeInput(ctx, body, current);
  const phoneE164 = input.phoneE164 ?? current.phoneE164;
  const set: Record<string, unknown> = { ...input.set };
  if (input.variables) set.variables = input.variables;
  if (body.listIds !== undefined) set.listIds = await assertOwnLists(ctx.accountId, body.listIds);
  if (input.phoneE164 && input.phoneE164 !== current.phoneE164) {
    set.phoneE164 = phoneE164;
    set.dnd = await isOnDnd(ctx.accountId, phoneE164);
  }
  await assertNoDuplicates(
    ctx.accountId,
    {
      ...(set.phoneE164 ? { phoneE164 } : {}),
      ...(set.externalId ? { externalId: set.externalId as string } : {}),
    },
    current._id,
  );
  set.searchText = buildSearchText({
    name: (set.name === undefined ? current.name : set.name) as string | null,
    email: (set.email === undefined ? current.email : set.email) as string | null,
    phoneE164,
    externalId: (set.externalId === undefined ? current.externalId : set.externalId) as
      string | null,
  });
  try {
    const updated = await ContactModel.findOneAndUpdate(
      { _id: current._id, accountId: ctx.accountId },
      { $set: set },
      { returnDocument: 'after' },
    ).lean<ContactDoc>();
    if (!updated) throw new NotFoundError('Contact not found');
    return { ...toPublicContact(updated), lists: await listNames(ctx.accountId, updated.listIds) };
  } catch (err) {
    return rethrowDuplicate(err);
  }
};

export const deleteContact = async (req: Request, id: string): Promise<void> => {
  const contact = await findLive(req, id);
  await ContactModel.updateOne(
    { _id: contact._id, accountId: contact.accountId },
    { $set: { deletedAt: new Date() } },
  );
  await auditRequest(req, 'contacts.deleted', {
    target: { type: 'contact', id: contact._id.toString() },
    meta: { count: 1, mode: 'single' },
  });
};

export const listTags = async (req: Request): Promise<{ tag: string; count: number }[]> => {
  const rows = await ContactModel.aggregate<{ _id: string; count: number }>([
    { $match: { ...tenantFilter(req), deletedAt: null } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 200 },
  ]);
  return rows.map((r) => ({ tag: r._id, count: r.count }));
};
