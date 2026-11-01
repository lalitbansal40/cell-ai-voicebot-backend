import { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import { ContactModel } from '../../db/models/contact.model';
import { CustomFieldModel } from '../../db/models/custom-field.model';
import type { ContactJobData } from '../contacts/jobs';
import { decryptValue, encryptValue, isEncrypted } from '../privacy/sensitive';

/**
 * `field.delete_values` — removes a deleted field's values from every contact
 * (also soft-deleted ones). Skipped if a field with the same key exists again.
 */
export const deleteFieldValues = async ({
  accountId,
  key,
}: ContactJobData['field.delete_values']): Promise<{ updated: number; skipped?: true }> => {
  const account = new Types.ObjectId(accountId);
  if (await CustomFieldModel.exists({ accountId: account, key }))
    return { updated: 0, skipped: true };
  const path = `variables.${key}`;
  const result = await ContactModel.updateMany(
    { accountId: account, [path]: { $exists: true } },
    { $unset: { [path]: '' } },
    { withDeleted: true } as never,
  );
  if (result.modifiedCount > 0)
    notifyAccount(accountId, 'contacts.changed', { reason: 'field_deleted' });
  return { updated: result.modifiedCount };
};

const SENSITIVE_BATCH = 500;

/**
 * `contacts.sensitive_field` — seals or opens one field's values to match its setting. Safe to
 * run again: it only picks values in the wrong form, and a concurrent save wins.
 */
export const moveSensitiveValues = async ({
  accountId,
  fieldId,
}: ContactJobData['contacts.sensitive_field']): Promise<{ moved: number; skipped?: true }> => {
  const account = new Types.ObjectId(accountId);
  const field = await CustomFieldModel.findOne({ _id: fieldId, accountId: account }).lean<{
    _id: Types.ObjectId;
    key: string;
    sensitive?: boolean;
  }>();
  if (!field) return { moved: 0, skipped: true };
  const path = `variables.${field.key}`;
  const collection = ContactModel.collection;
  const wrongForm = field.sensitive
    ? { [path]: { $type: ['string', 'number', 'int', 'long', 'double', 'decimal'] } }
    : { [`${path}.$enc`]: { $type: 'string' } };
  const base = { accountId: account, ...wrongForm };
  const total = await collection.countDocuments(base);
  let moved = 0;
  let after: Types.ObjectId | null = null;
  const progress = (status: 'running' | 'done') =>
    CustomFieldModel.updateOne(
      { _id: field._id, accountId: account },
      { $set: { sensitiveJob: { status, done: moved, total } } },
    );
  for (;;) {
    const page = await collection
      .find(after ? { ...base, _id: { $gt: after } } : base)
      .project<{ _id: Types.ObjectId; variables: Record<string, unknown> }>({ [path]: 1 })
      .sort({ _id: 1 })
      .limit(SENSITIVE_BATCH)
      .toArray();
    for (const doc of page) {
      const value = doc.variables[field.key];
      let next: unknown = null;
      if (field.sensitive && (typeof value === 'string' || typeof value === 'number')) {
        next = encryptValue(value);
      } else if (!field.sensitive && isEncrypted(value)) next = decryptValue(value);
      if (next === null) continue;
      // only if it's still the value we read
      const guard = isEncrypted(value) ? { [`${path}.$enc`]: value.$enc } : { [path]: value };
      await collection.updateOne(
        { _id: doc._id, accountId: account, ...guard },
        { $set: { [path]: next } },
      );
      moved += 1;
    }
    const last = page.at(-1);
    if (!last) break;
    after = last._id;
    await progress('running');
    if (page.length < SENSITIVE_BATCH) break;
  }
  await progress('done');
  notifyAccount(accountId, 'contacts.changed', { reason: 'field_sensitive_changed' });
  return { moved };
};
