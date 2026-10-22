import type { Types } from 'mongoose';

import { tryGetRealtime } from '../../core/realtime';
import { notifyAccount } from '../../core/realtime/notify';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import type { MessageDoc } from '../../db/models/message.model';
import { getLogger } from '../../shared/logger';

import { conversationEvent, toMessageView, type ReplyToView } from './inbox-json';

export const conversationTopic = (conversationId: Types.ObjectId | string): string =>
  `conversation:${conversationId.toString()}`;

const pushTopic = (topic: string, type: string, data: unknown): void => {
  const rt = tryGetRealtime();
  if (!rt) return;
  void rt.pushToTopic(topic, type, data).catch((err: unknown) => {
    getLogger().warn({ err, type }, 'realtime: topic push failed');
  });
};

/** Account event (no text) for a changed conversation. */
export const emitConversation = (c: ConversationDoc): void => {
  notifyAccount(c.accountId.toString(), 'inbox.conversation.updated', conversationEvent(c));
};

/** Unread-conversations count for the nav badge. */
export const emitSummary = async (accountId: Types.ObjectId): Promise<void> => {
  if (!tryGetRealtime()) return;
  const unreadConversations = await ConversationModel.countDocuments({
    accountId,
    unreadCount: { $gt: 0 },
  });
  notifyAccount(accountId.toString(), 'inbox.summary.updated', { unreadConversations });
};

/** Full message view to the conversation topic. */
export const emitMessageCreated = (
  m: MessageDoc,
  extra: { replyTo?: ReplyToView | null; sentBy?: { id: string; name: string } | null } = {},
): void => {
  pushTopic(conversationTopic(m.conversationId), 'inbox.message.created', {
    message: toMessageView(m, extra),
  });
};

export const emitMessageUpdated = (m: MessageDoc): void => {
  pushTopic(conversationTopic(m.conversationId), 'inbox.message.updated', {
    messageId: m._id.toString(),
    status: m.status,
    error: m.error ? { code: m.error.code, reason: m.error.reason } : null,
    media: m.media ? { status: m.media.status } : null,
    reactions: m.reactions.map((r) => ({ emoji: r.emoji, by: r.by })),
  });
};

export const emitTyping = (
  conversationId: Types.ObjectId,
  user: { id: string; name: string },
): void => {
  pushTopic(conversationTopic(conversationId), 'inbox.typing', {
    conversationId: conversationId.toString(),
    userId: user.id,
    name: user.name,
  });
};
