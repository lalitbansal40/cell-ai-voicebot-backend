import type { Request } from 'express';
import { Types } from 'mongoose';

import type { StorageProvider } from '../../core/storage';
import { LIVE_CALL_STATUSES, CallModel } from '../../db/models/call.model';
import { ContactModel } from '../../db/models/contact.model';
import { ConversationModel } from '../../db/models/conversation.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import { EraseJobModel, type EraseJobDoc } from '../../db/models/erase-job.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import type { ContactJobs } from '../contacts/jobs';

import { ERASE_MAP, type EraseContext } from './erase-map';
import { assertSuppressionReady, recordSuppression } from './suppression';

const ERASE_JOB_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface StoredContact {
  _id: Types.ObjectId;
  phoneE164: string;
  name?: string | null;
  dnd?: boolean;
  optedOutAt?: Date | null;
  whatsapp?: { waId?: string | null } | null;
}

export type EraseCounts = Record<string, number>;

const callIdsOf = async (
  accountId: Types.ObjectId,
  contact: StoredContact,
  waId: string | null,
) => {
  const phones = [contact.phoneE164, ...(waId ? [waId] : [])];
  const rows = await CallModel.collection
    .find({
      accountId,
      $or: [{ contactId: contact._id }, { to: { $in: phones } }, { from: { $in: phones } }],
    })
    .project<{ _id: Types.ObjectId; status: string }>({ status: 1 })
    .toArray();
  return rows;
};

/** True while a live call uses this contact. */
const hasLiveCall = (rows: { status: string }[]) =>
  rows.some((r) => (LIVE_CALL_STATUSES as readonly string[]).includes(r.status));

/**
 * Erases one person from every store. Safe to run again: the contact row goes last, so a
 * stopped run finds it and continues. Suppression is written first, so the number can't come
 * back meanwhile.
 */
export const eraseContactEverywhere = async (
  accountId: Types.ObjectId,
  contactId: Types.ObjectId,
  storage: StorageProvider,
): Promise<EraseCounts> => {
  // raw collection: soft-deleted contacts must be erasable too
  const contact = await ContactModel.collection.findOne<StoredContact>({
    _id: contactId,
    accountId,
  });
  if (!contact) throw new NotFoundError('Contact not found');
  const waId = contact.whatsapp?.waId ?? contact.phoneE164.replace(/^\+/, '');
  const calls = await callIdsOf(accountId, contact, waId);
  if (hasLiveCall(calls)) throw new AppError('CONTACT_ERASE_BLOCKED');

  const onDnd =
    contact.dnd ||
    (await DndEntryModel.collection.findOne({
      accountId,
      phoneE164: contact.phoneE164,
    }));
  await recordSuppression(
    accountId,
    contact.phoneE164,
    contact.optedOutAt ? 'opted_out' : onDnd ? 'dnd' : 'erased',
  );

  const conversations = await ConversationModel.collection
    .find({
      accountId,
      $or: [{ contactId: contact._id }, { phoneE164: contact.phoneE164 }, { waId }],
    })
    .project<{ _id: Types.ObjectId }>({ _id: 1 })
    .toArray();
  const ctx: EraseContext = {
    accountId,
    contactId: contact._id,
    phoneE164: contact.phoneE164,
    waId,
    name: contact.name ?? null,
    callIds: calls.map((c) => c._id),
    conversationIds: conversations.map((c) => c._id),
    storage,
  };
  const counts: EraseCounts = {};
  for (const entry of ERASE_MAP) {
    if (!entry.run) continue;
    const n = await entry.run(ctx);
    if (n > 0) counts[entry.store] = n;
  }
  return counts;
};

export const eraseContact = async (
  req: Request,
  id: string,
  storage: StorageProvider,
): Promise<{ erased: true; counts: EraseCounts }> => {
  assertSuppressionReady();
  const { accountId } = tenantFilter(req);
  const contactId = toObjectId(id);
  if (!contactId) throw new NotFoundError('Contact not found');
  const counts = await eraseContactEverywhere(accountId, contactId, storage);
  await auditRequest(req, 'contact.erased', {
    target: { type: 'contact', id },
    meta: { stores: Object.keys(counts).length },
  });
  return { erased: true, counts };
};

export const toEraseJobView = (job: EraseJobDoc) => ({
  id: job._id.toString(),
  status: job.status,
  total: job.total,
  done: job.done,
  retried: job.retried,
  createdAt: job.createdAt.toISOString(),
  updatedAt: job.updatedAt.toISOString(),
});

export const startBulkErase = async (req: Request, ids: string[], jobs: ContactJobs) => {
  assertSuppressionReady();
  const { accountId } = tenantFilter(req);
  const unique = [...new Set(ids)].map((id) => new Types.ObjectId(id));
  const owned = await ContactModel.collection
    .find({ accountId, _id: { $in: unique } })
    .project<{ _id: Types.ObjectId }>({ _id: 1 })
    .toArray();
  if (owned.length !== unique.length) throw new NotFoundError('Some contacts were not found');
  const job = await EraseJobModel.create({
    accountId,
    requestedBy: new Types.ObjectId(requireAuth(req).userId),
    contactIds: unique,
    total: unique.length,
    expiresAt: new Date(Date.now() + ERASE_JOB_TTL_MS),
  });
  await jobs.enqueue('contacts.erase', {
    accountId: accountId.toString(),
    eraseJobId: job._id.toString(),
  });
  await auditRequest(req, 'contacts.bulk_erased', {
    target: { type: 'erase_job', id: job._id.toString() },
    meta: { count: unique.length },
  });
  return toEraseJobView(job.toObject({ transform: false }));
};

export const getEraseJob = async (req: Request, id: string) => {
  const _id = toObjectId(id);
  const job = _id
    ? await EraseJobModel.findOne({ _id, ...tenantFilter(req) }).lean<EraseJobDoc>()
    : null;
  if (!job) throw new NotFoundError();
  return toEraseJobView(job);
};
