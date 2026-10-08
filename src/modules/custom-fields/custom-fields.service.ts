import type { Request } from 'express';
import type { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel } from '../../db/models/account.model';
import { ContactModel } from '../../db/models/contact.model';
import {
  CustomFieldModel,
  type CustomFieldDoc,
  type FieldType,
} from '../../db/models/custom-field.model';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import type { ContactJobs } from '../contacts/jobs';
import { parseFieldValue } from '../contacts/normalize';

export interface PublicCustomField {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  defaultValue: string | number | null;
  order: number;
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export const toPublicField = (f: CustomFieldDoc, usageCount?: number): PublicCustomField => ({
  id: f._id.toString(),
  key: f.key,
  label: f.label,
  type: f.type,
  required: f.required,
  defaultValue: f.defaultValue ?? null,
  order: f.order,
  ...(usageCount === undefined ? {} : { usageCount }),
  createdAt: f.createdAt.toISOString(),
  updatedAt: f.updatedAt.toISOString(),
});

/** Field definitions of an account, in display order (used by every contact module). */
export const loadFields = (accountId: Types.ObjectId): Promise<CustomFieldDoc[]> =>
  CustomFieldModel.find({ accountId }).sort({ order: 1, createdAt: 1 }).lean<CustomFieldDoc[]>();

/** Live contacts that have a value for `key`. */
export const fieldUsage = (accountId: Types.ObjectId, key: string): Promise<number> =>
  ContactModel.countDocuments({ accountId, [`variables.${key}`]: { $exists: true } });

const accountCountry = async (accountId: Types.ObjectId) =>
  ((await AccountModel.findById(accountId).select({ country: 1 }).lean<{ country?: string }>())
    ?.country ?? 'IN') as 'IN';

/** Input default (rupees, DD/MM/YYYY …) → stored form, or 422. */
const parseDefault = async (
  accountId: Types.ObjectId,
  type: FieldType,
  raw: string | number | null | undefined,
): Promise<string | number | null> => {
  if (raw === null || raw === undefined) return null;
  const parsed = parseFieldValue(type, raw, { country: await accountCountry(accountId) });
  if (!parsed.ok) {
    throw new ValidationError([{ path: 'defaultValue', message: `Not a valid ${type} value` }]);
  }
  return parsed.value ?? null;
};

const findField = async (req: Request, id: string): Promise<CustomFieldDoc> => {
  const _id = toObjectId(id);
  const field = _id
    ? await CustomFieldModel.findOne({ _id, ...tenantFilter(req) }).lean<CustomFieldDoc>()
    : null;
  if (!field) throw new NotFoundError();
  return field;
};

export const listCustomFields = async (
  req: Request,
  { withUsage }: { withUsage: boolean },
): Promise<PublicCustomField[]> => {
  const { accountId } = tenantFilter(req);
  const fields = await loadFields(accountId);
  if (!withUsage) return fields.map((f) => toPublicField(f));
  const counts = await Promise.all(fields.map((f) => fieldUsage(accountId, f.key)));
  return fields.map((f, i) => toPublicField(f, counts[i]));
};

export const createCustomField = async (
  req: Request,
  body: {
    key: string;
    label: string;
    type: FieldType;
    required: boolean;
    defaultValue?: string | number | null;
  },
): Promise<PublicCustomField> => {
  const { accountId } = tenantFilter(req);
  const existing = await CustomFieldModel.find({ accountId })
    .select({ key: 1, order: 1 })
    .lean<Pick<CustomFieldDoc, '_id' | 'key' | 'order'>[]>();
  const same = existing.find((f) => f.key === body.key);
  if (same) {
    throw new ConflictError('CONFLICT_DUPLICATE', 'A field with this key already exists.', [
      { path: 'key', message: 'Already exists', existingId: same._id.toString() },
    ]);
  }
  if (existing.length >= CONTACT_LIMITS.customFieldsPerAccount) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${CONTACT_LIMITS.customFieldsPerAccount} custom fields.`,
    );
  }
  const defaultValue = await parseDefault(accountId, body.type, body.defaultValue);
  try {
    const doc = await CustomFieldModel.create({
      accountId,
      key: body.key,
      label: body.label,
      type: body.type,
      required: body.required,
      defaultValue,
      order: Math.max(0, ...existing.map((f) => f.order)) + 1,
    });
    await auditRequest(req, 'custom_field.created', {
      target: { type: 'custom_field', id: doc._id.toString() },
      meta: { key: body.key, type: body.type },
    });
    return toPublicField(doc.toObject({ transform: false }));
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new ConflictError('CONFLICT_DUPLICATE', 'A field with this key already exists.');
    }
    throw err;
  }
};

export const updateCustomField = async (
  req: Request,
  id: string,
  body: {
    label?: string;
    type?: FieldType;
    required?: boolean;
    defaultValue?: string | number | null;
  },
): Promise<PublicCustomField> => {
  const field = await findField(req, id);
  const typeChanges = body.type !== undefined && body.type !== field.type;
  if (typeChanges) {
    const used = await fieldUsage(field.accountId, field.key);
    if (used > 0) {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        `This field has data on ${used} contact${used === 1 ? '' : 's'} — its type can't change.`,
      );
    }
  }
  const type = body.type ?? field.type;
  const set: Partial<CustomFieldDoc> = {};
  if (body.label !== undefined) set.label = body.label;
  if (body.required !== undefined) set.required = body.required;
  if (typeChanges) set.type = type;
  if (body.defaultValue !== undefined) {
    set.defaultValue = await parseDefault(field.accountId, type, body.defaultValue);
  } else if (typeChanges) {
    set.defaultValue = null; // the old default was typed for the old type
  }
  const updated = await CustomFieldModel.findOneAndUpdate(
    { _id: field._id, accountId: field.accountId },
    { $set: set },
    { new: true },
  ).lean<CustomFieldDoc>();
  if (!updated) throw new NotFoundError();
  await auditRequest(req, 'custom_field.updated', {
    target: { type: 'custom_field', id: field._id.toString() },
    meta: { key: field.key, fields: Object.keys(set) },
  });
  return toPublicField(updated);
};

export const reorderCustomFields = async (
  req: Request,
  ids: string[],
): Promise<PublicCustomField[]> => {
  const { accountId } = tenantFilter(req);
  const fields = await loadFields(accountId);
  const known = new Set(fields.map((f) => f._id.toString()));
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== known.size ||
    !ids.every((i) => known.has(i))
  ) {
    throw new ValidationError([
      { path: 'ids', message: 'Send every field id of the account exactly once' },
    ]);
  }
  await CustomFieldModel.bulkWrite(
    ids.map((id, index) => ({
      updateOne: {
        filter: { _id: toObjectId(id), accountId },
        update: { $set: { order: index + 1 } },
      },
    })),
  );
  return (await loadFields(accountId)).map((f) => toPublicField(f));
};

export const deleteCustomField = async (
  req: Request,
  id: string,
  jobs: ContactJobs,
): Promise<void> => {
  const field = await findField(req, id);
  await CustomFieldModel.deleteOne({ _id: field._id, accountId: field.accountId });
  await jobs.enqueue('field.delete_values', {
    accountId: field.accountId.toString(),
    key: field.key,
  });
  await auditRequest(req, 'custom_field.deleted', {
    target: { type: 'custom_field', id: field._id.toString() },
    meta: { key: field.key },
  });
};
