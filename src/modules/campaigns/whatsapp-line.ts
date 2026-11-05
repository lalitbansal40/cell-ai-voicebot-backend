import type { Types } from 'mongoose';

import { WhatsAppCallPermissionModel } from '../../db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { ValidationError } from '../../shared/errors/app-error';
import { activeRestrictions, bicCountryBlocked } from '../whatsapp-calling/availability';

export const allowedCallContacts = async (
  accountId: Types.ObjectId,
  channelId: Types.ObjectId,
  ids: Types.ObjectId[],
  now = new Date(),
) =>
  new Set(
    (
      await WhatsAppCallPermissionModel.find({
        accountId,
        channelId,
        contactId: { $in: ids },
        $or: [{ status: 'permanent' }, { status: 'temporary', expiresAt: { $gt: now } }],
      })
        .select({ contactId: 1 })
        .lean<{ contactId: Types.ObjectId }[]>()
    ).map((row) => row.contactId.toString()),
  );

export const validateWhatsAppLine = async (
  accountId: Types.ObjectId,
  channelId: Types.ObjectId | null | undefined,
) => {
  const channel = channelId
    ? await WhatsAppChannelModel.findOne({ _id: channelId, accountId }).lean()
    : null;
  if (
    !channel ||
    !['connected', 'action_needed'].includes(channel.status) ||
    channel.mode === 'coexistence' ||
    channel.isOnBizApp ||
    channel.calling?.status !== 'enabled' ||
    bicCountryBlocked(channel) ||
    activeRestrictions(channel.calling, 'business', new Date()).length > 0
  )
    throw new ValidationError([
      {
        path: 'channelId',
        message: 'Choose a connected WhatsApp number with calling enabled and ready',
      },
    ]);
  return channel;
};
