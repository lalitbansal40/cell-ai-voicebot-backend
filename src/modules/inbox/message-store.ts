import type { Types } from 'mongoose';

import type { ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';

import type { NormalizedContent } from './normalize';

/** Empty content (every optional part null) — callers fill what the type needs. */
export const blankContent = (type: MessageDoc['type']): NormalizedContent => ({
  type,
  text: null,
  media: null,
  location: null,
  contacts: null,
  interactive: null,
  reaction: null,
  context: null,
  order: null,
  button: null,
  system: null,
  error: null,
});

export type NewMessage = NormalizedContent &
  Pick<MessageDoc, 'direction' | 'origin' | 'status' | 'at'> &
  Partial<
    Pick<
      MessageDoc,
      'waMessageId' | 'clientId' | 'sentBy' | 'retryOf' | 'metaTimestamp' | 'statusHistory'
    >
  >;

/** Inserts a message of `conversation`; returns the stored document (with `_id`). */
export const insertMessage = async (
  conversation: Pick<ConversationDoc, '_id' | 'accountId' | 'channelId' | 'contactId'>,
  m: NewMessage,
): Promise<MessageDoc> => {
  const doc = await MessageModel.create({
    accountId: conversation.accountId,
    conversationId: conversation._id,
    channelId: conversation.channelId,
    contactId: conversation.contactId,
    ...m,
  });
  return doc.toObject({ transform: false });
};

/** A centred system line in the chat (opt-out / opt-in / number changed …) — never unread. */
export const insertSystemLine = (
  conversation: Pick<ConversationDoc, '_id' | 'accountId' | 'channelId' | 'contactId'>,
  kind: string,
  at: Date,
): Promise<MessageDoc> =>
  insertMessage(conversation, {
    ...blankContent('system'),
    system: { kind, newWaIdLast4: null },
    direction: 'in',
    origin: 'system',
    status: 'received',
    at,
  });

export const messageId = (m: { _id: Types.ObjectId }): string => m._id.toString();
