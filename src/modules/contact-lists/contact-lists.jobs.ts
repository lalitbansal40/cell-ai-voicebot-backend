import { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import { ContactModel } from '../../db/models/contact.model';
import type { ContactJobData } from '../contacts/jobs';

/** `list.delete_members` — removes a deleted list from every contact (idempotent). */
export const deleteListMembers = async ({
  accountId,
  listId,
}: ContactJobData['list.delete_members']): Promise<{ updated: number }> => {
  const list = new Types.ObjectId(listId);
  const result = await ContactModel.updateMany(
    { accountId: new Types.ObjectId(accountId), listIds: list },
    { $pull: { listIds: list } },
    { withDeleted: true } as never,
  );
  if (result.modifiedCount > 0)
    notifyAccount(accountId, 'contacts.changed', { reason: 'list_deleted' });
  return { updated: result.modifiedCount };
};
