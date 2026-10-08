import { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import { ContactModel } from '../../db/models/contact.model';
import { CustomFieldModel } from '../../db/models/custom-field.model';
import type { ContactJobData } from '../contacts/jobs';

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
