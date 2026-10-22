import type { Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import {
  ConversationModel,
  type ConversationDoc,
  type ConversationSource,
} from '../../db/models/conversation.model';
import type { MessageDoc } from '../../db/models/message.model';

import { buildPreview } from './preview';

export interface ConversationKey {
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  waId: string;
}

/**
 * Atomic upsert of the conversation for a message (one per number × customer).
 * `inbound` (a customer message): reopens, refreshes the 24-hour window ($max — out
 * of order safe) and counts unread unless `countUnread` is false (reactions /
 * system lines). Other kinds only create the row / keep the contact link.
 */
export const upsertConversation = async (input: {
  key: ConversationKey;
  contactId: Types.ObjectId;
  source: ConversationSource;
  profileName?: string | null;
  inbound?: { at: Date; countUnread: boolean } | null;
}): Promise<ConversationDoc> => {
  const { key, inbound } = input;
  const update: Record<string, Record<string, unknown>> = {
    $setOnInsert: {
      accountId: key.accountId,
      channelId: key.channelId,
      waId: key.waId,
      phoneE164: `+${key.waId}`,
      source: input.source,
    },
    // follows the live contact (a deleted contact's chat moves to the new one)
    $set: { contactId: input.contactId },
  };
  if (input.profileName)
    update.$set = { ...update.$set, profileName: input.profileName.slice(0, 256) };
  if (inbound) {
    update.$set = { ...update.$set, status: 'open', closedAt: null, closedBy: null };
    update.$max = {
      lastInboundAt: inbound.at,
      windowExpiresAt: new Date(inbound.at.getTime() + INBOX_LIMITS.windowMs),
    };
    if (inbound.countUnread) update.$inc = { unreadCount: 1 };
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      const doc = await ConversationModel.findOneAndUpdate(
        { accountId: key.accountId, channelId: key.channelId, waId: key.waId },
        update,
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean<ConversationDoc>();
      /* c8 ignore next -- upsert always returns a document */
      if (!doc) throw new Error('conversation upsert returned nothing');
      return doc;
    } catch (err) {
      // two first messages of a new customer at once: the other upsert inserted it
      if (!isDuplicateKeyError(err) || attempt > 0) throw err;
    }
  }
};

/** Sets `lastMessage` only when `m` is not older than the current one. Returns the row. */
export const touchLastMessage = async (
  conversationId: Types.ObjectId,
  m: Pick<
    MessageDoc,
    | '_id'
    | 'direction'
    | 'type'
    | 'text'
    | 'media'
    | 'contacts'
    | 'interactive'
    | 'reaction'
    | 'location'
    | 'at'
    | 'status'
  >,
): Promise<ConversationDoc | null> => {
  const lastMessage = {
    id: m._id,
    direction: m.direction,
    type: m.type,
    preview: buildPreview(m),
    at: m.at,
    status: m.status,
  };
  const updated = await ConversationModel.findOneAndUpdate(
    {
      _id: conversationId,
      $or: [{ lastMessage: null }, { 'lastMessage.at': { $lte: m.at } }],
    },
    { $set: { lastMessage } },
    { returnDocument: 'after' },
  ).lean<ConversationDoc>();
  return updated ?? (await ConversationModel.findById(conversationId).lean<ConversationDoc>());
};

/** Keeps the list row's tick in step when the last message's status changes. */
export const syncLastMessageStatus = (m: Pick<MessageDoc, '_id' | 'conversationId' | 'status'>) =>
  ConversationModel.findOneAndUpdate(
    { _id: m.conversationId, 'lastMessage.id': m._id },
    { $set: { 'lastMessage.status': m.status } },
    { returnDocument: 'after' },
  ).lean<ConversationDoc>();
