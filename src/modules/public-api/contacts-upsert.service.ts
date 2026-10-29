import type { Request } from 'express';
import type { z } from 'zod';

import { ContactModel } from '../../db/models/contact.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import type { CreateContactBody } from '../contacts/contacts.schema';
import { createContact, updateContact, type PublicContact } from '../contacts/contacts.service';
import { loadContactContext } from '../contacts/context';
import { normalizePhone } from '../contacts/normalize';

export type UpsertKey = 'phone' | 'externalId';
type ContactBody = z.infer<typeof CreateContactBody>;

/** The live contact the row matches on `by` (phone in E.164, or externalId), else null. */
const findMatch = async (req: Request, body: ContactBody, by: UpsertKey) => {
  const { accountId } = tenantFilter(req);
  if (by === 'externalId') {
    const externalId = body.externalId?.trim();
    if (!externalId) {
      throw new ValidationError([
        { path: 'externalId', message: 'Needed to upsert by externalId' },
      ]);
    }
    return ContactModel.findOne({ accountId, externalId, deletedAt: null })
      .select({ _id: 1 })
      .lean();
  }
  const ctx = await loadContactContext(accountId);
  const phone = normalizePhone(body.phone, ctx.country);
  if (!phone.ok) throw new ValidationError([{ path: 'phone', message: 'Invalid phone' }]);
  return ContactModel.findOne({ accountId, phoneE164: phone.e164, deletedAt: null })
    .select({ _id: 1 })
    .lean();
};

/** A duplicate on create = another request created it first: update that one instead. */
const isDuplicate = (err: unknown) => err instanceof AppError && err.code === 'CONFLICT_DUPLICATE';

/**
 * `POST /contacts?upsert=phone|externalId` (PHASE_15_PLAN §1b): creates the contact
 * or updates the one that matches — the dashboard's own create / update (validation,
 * custom fields by key, DND lookup). Opt-out and DND are never cleared through the
 * API (§7 #7): the body has no such fields; `consent` is stored as given.
 */
export const upsertContact = async (
  req: Request,
  body: ContactBody,
  by: UpsertKey,
): Promise<{ contact: PublicContact; created: boolean }> => {
  const match = await findMatch(req, body, by);
  if (match)
    return { contact: await updateContact(req, match._id.toString(), body), created: false };
  try {
    return { contact: await createContact(req, body), created: true };
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    // a concurrent upsert won the unique index: this row becomes an update
    const raced = await findMatch(req, body, by);
    if (!raced) throw err;
    return { contact: await updateContact(req, raced._id.toString(), body), created: false };
  }
};

export interface BulkUpsertRow {
  index: number;
  status: 'created' | 'updated' | 'failed';
  id?: string;
  error?: { code: string; message: string; details?: { path: string; message: string }[] };
}

/**
 * `POST /contacts/bulk-upsert` (≤ 1,000 rows): row by row through `upsertContact`,
 * so one bad row never stops the others. Per-row result, counts.
 */
export const bulkUpsertContacts = async (req: Request, rows: ContactBody[], by: UpsertKey) => {
  const results: BulkUpsertRow[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const r = await upsertContact(req, row, by);
      results.push({ index, status: r.created ? 'created' : 'updated', id: r.contact.id });
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      results.push({
        index,
        status: 'failed',
        error: {
          code: err.code,
          message: err.message,
          ...(err.details?.length
            ? { details: err.details.map((d) => ({ path: d.path, message: d.message })) }
            : {}),
        },
      });
    }
  }
  const count = (s: BulkUpsertRow['status']) => results.filter((r) => r.status === s).length;
  return { created: count('created'), updated: count('updated'), failed: count('failed'), results };
};

/** The live contact with this phone, or a new one (source `api`) — for sends to a number. */
export const findOrCreateByPhone = async (req: Request, phone: string): Promise<string> => {
  const body = { phone } as ContactBody;
  const match = await findMatch(req, body, 'phone');
  if (match) return match._id.toString();
  try {
    return (await createContact(req, body)).id;
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    const raced = await findMatch(req, body, 'phone');
    if (!raced) throw err;
    return raced._id.toString();
  }
};
