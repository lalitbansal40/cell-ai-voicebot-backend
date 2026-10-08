import type { Request } from 'express';
import { Types } from 'mongoose';

import { isDuplicateKeyError } from '../../db/errors';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { DndEntryModel, type DndEntryDoc, type DndSource } from '../../db/models/dnd-entry.model';
import { withTransaction } from '../../db/transaction';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { toPublicContact, type PublicContact } from '../contacts/contacts.service';
import { loadContactContext } from '../contacts/context';
import { normalizePhone, phoneDigits } from '../contacts/normalize';

export const OPT_OUT_REASON = 'Opted out';

export interface PublicDndEntry {
  id: string;
  phoneE164: string;
  reason: string | null;
  source: DndSource;
  addedBy: string | null;
  createdAt: string;
}

const toPublicDnd = (d: DndEntryDoc): PublicDndEntry => ({
  id: d._id.toString(),
  phoneE164: d.phoneE164,
  reason: d.reason ?? null,
  source: d.source,
  addedBy: d.addedBy ? d.addedBy.toString() : null,
  createdAt: d.createdAt.toISOString(),
});

export const listDnd = async (req: Request, q: { page: number; limit: number; q?: string }) => {
  const filter: Record<string, unknown> = { ...tenantFilter(req) };
  const digits = q.q ? phoneDigits(q.q) : '';
  if (q.q && !digits) throw new ValidationError([{ path: 'q', message: 'Search by phone digits' }]);
  if (digits) filter.phoneE164 = { $regex: digits };
  const [entries, total] = await Promise.all([
    DndEntryModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<DndEntryDoc[]>(),
    DndEntryModel.countDocuments(filter),
  ]);
  return {
    items: entries.map(toPublicDnd),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

/**
 * Puts phones on the DND list and flags matching contacts (one transaction).
 * Returns the entries that were newly created.
 */
export const addDndEntries = async (
  accountId: Types.ObjectId,
  entries: { phoneE164: string; reason?: string | null }[],
  source: DndSource,
  addedBy: Types.ObjectId | null,
): Promise<number> => {
  if (!entries.length) return 0;
  return withTransaction(async (session) => {
    const result = await DndEntryModel.bulkWrite(
      entries.map((e) => ({
        updateOne: {
          filter: { accountId, phoneE164: e.phoneE164 },
          update: {
            $setOnInsert: {
              accountId,
              phoneE164: e.phoneE164,
              reason: e.reason ?? null,
              source,
              addedBy,
            },
          },
          upsert: true,
        },
      })),
      { session },
    );
    await ContactModel.updateMany(
      { accountId, phoneE164: { $in: entries.map((e) => e.phoneE164) } },
      { $set: { dnd: true } },
      { session, withDeleted: true } as never,
    );
    return result.upsertedCount;
  });
};

export const addDnd = async (
  req: Request,
  body: { phone: string; reason?: string | null },
): Promise<{ entry: PublicDndEntry; created: boolean }> => {
  const { accountId } = tenantFilter(req);
  const ctx = await loadContactContext(accountId);
  const phone = normalizePhone(body.phone, ctx.country);
  if (!phone.ok)
    throw new ValidationError([{ path: 'phone', message: 'Not a valid phone number' }]);
  let created: number;
  try {
    created = await addDndEntries(
      accountId,
      [{ phoneE164: phone.e164, reason: body.reason ?? null }],
      'manual',
      new Types.ObjectId(requireAuth(req).userId),
    );
  } catch (err) {
    /* c8 ignore next 2 -- concurrent add of the same number: the other request won */
    if (!isDuplicateKeyError(err)) throw err;
    created = 0;
  }
  const entry = await DndEntryModel.findOne({
    accountId,
    phoneE164: phone.e164,
  }).lean<DndEntryDoc>();
  if (!entry) throw new NotFoundError();
  if (created) {
    await auditRequest(req, 'dnd.added', {
      target: { type: 'dnd_entry', id: entry._id.toString() },
      meta: { count: 1, source: 'manual' },
    });
  }
  return { entry: toPublicDnd(entry), created: created > 0 };
};

/** Removes a number from the DND list; contacts' opt-outs are kept. */
export const removeDnd = async (req: Request, id: string): Promise<void> => {
  const _id = toObjectId(id);
  const entry = _id
    ? await DndEntryModel.findOne({ _id, ...tenantFilter(req) }).lean<DndEntryDoc>()
    : null;
  if (!entry) throw new NotFoundError();
  await withTransaction(async (session) => {
    await DndEntryModel.deleteOne({ _id: entry._id, accountId: entry.accountId }, { session });
    await ContactModel.updateMany(
      { accountId: entry.accountId, phoneE164: entry.phoneE164 },
      { $set: { dnd: false } },
      { session, withDeleted: true } as never,
    );
  });
  await auditRequest(req, 'dnd.removed', {
    target: { type: 'dnd_entry', id: entry._id.toString() },
    meta: { optOutCleared: false },
  });
};

const findContact = async (req: Request, id: string): Promise<ContactDoc> => {
  const _id = toObjectId(id);
  const contact = _id
    ? await ContactModel.findOne({ _id, ...tenantFilter(req) }).lean<ContactDoc>()
    : null;
  if (!contact) throw new NotFoundError('Contact not found');
  return contact;
};

export const optOut = async (req: Request, id: string): Promise<PublicContact> => {
  const contact = await findContact(req, id);
  if (contact.optedOutAt) return toPublicContact(contact);
  await addDndEntries(
    contact.accountId,
    [{ phoneE164: contact.phoneE164, reason: OPT_OUT_REASON }],
    'manual',
    new Types.ObjectId(requireAuth(req).userId),
  );
  const updated = await ContactModel.findOneAndUpdate(
    { _id: contact._id, accountId: contact.accountId },
    { $set: { optedOutAt: new Date(), dnd: true } },
    { returnDocument: 'after' },
  ).lean<ContactDoc>();
  await auditRequest(req, 'contact.opted_out', {
    target: { type: 'contact', id: contact._id.toString() },
  });
  return toPublicContact(updated ?? contact);
};

export const undoOptOut = async (req: Request, id: string): Promise<PublicContact> => {
  const contact = await findContact(req, id);
  const updated = await withTransaction(async (session) => {
    await DndEntryModel.deleteOne(
      { accountId: contact.accountId, phoneE164: contact.phoneE164 },
      { session },
    );
    await ContactModel.updateMany(
      { accountId: contact.accountId, phoneE164: contact.phoneE164 },
      { $set: { dnd: false } },
      { session, withDeleted: true } as never,
    );
    return ContactModel.findOneAndUpdate(
      { _id: contact._id, accountId: contact.accountId },
      { $set: { optedOutAt: null, dnd: false } },
      { returnDocument: 'after', session },
    ).lean<ContactDoc>();
  });
  await auditRequest(req, 'dnd.removed', {
    target: { type: 'contact', id: contact._id.toString() },
    meta: { optOutCleared: true },
  });
  return toPublicContact(updated ?? contact);
};
