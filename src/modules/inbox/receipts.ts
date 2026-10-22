import { Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { isMetaApiError } from '../../core/meta';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { markNeedsReconnect } from '../whatsapp/channel-status';
import { openSecret } from '../whatsapp/context';

import { inboxNow, type InboxContext } from './context';
import { emitConversation, emitSummary, emitTyping } from './events';
import { loadInboxSettings } from './inbound.service';
import { isWindowOpen } from './outbound.service';

const findConversation = async (accountId: Types.ObjectId, conversationId: string) => {
  const c = await ConversationModel.findOne({
    _id: new Types.ObjectId(conversationId),
    accountId,
  }).lean<ConversationDoc>();
  if (!c) throw new NotFoundError('Conversation not found');
  return c;
};

/** The customer's latest message Meta can mark read (it marks earlier ones too). */
const latestInbound = (conversationId: Types.ObjectId) =>
  MessageModel.findOne({
    conversationId,
    direction: 'in',
    origin: 'customer',
    waMessageId: { $type: 'string' },
  })
    .sort({ at: -1, _id: -1 })
    .lean<MessageDoc>();

/**
 * The team read the chat (PHASE_10_PLAN §1i): unread → 0, read marker, and — when the
 * account sends read receipts — a blue-tick job for the latest customer message.
 * Impersonating superadmins change nothing (read only).
 */
export const markConversationRead = async (
  ix: InboxContext,
  input: {
    accountId: Types.ObjectId;
    userId: Types.ObjectId;
    conversationId: string;
    impersonating: boolean;
  },
): Promise<ConversationDoc> => {
  const conversation = await findConversation(input.accountId, input.conversationId);
  if (input.impersonating) return conversation;
  const updated = await ConversationModel.findOneAndUpdate(
    { _id: conversation._id },
    { $set: { unreadCount: 0, lastReadAt: inboxNow(ix), lastReadBy: input.userId } },
    { returnDocument: 'after' },
  ).lean<ConversationDoc>();
  const result = updated ?? conversation;
  if (conversation.unreadCount > 0) {
    emitConversation(result);
    await emitSummary(result.accountId);
  }
  const settings = await loadInboxSettings(input.accountId);
  if (settings.sendReadReceipts) {
    const latest = await latestInbound(conversation._id);
    if (latest) await ix.jobs.enqueueReadReceipt(latest._id.toString());
  }
  return result;
};

/** Team-only "mark as unread" (no Meta call). */
export const markConversationUnread = async (input: {
  accountId: Types.ObjectId;
  conversationId: string;
}): Promise<ConversationDoc> => {
  const conversation = await findConversation(input.accountId, input.conversationId);
  const updated = await ConversationModel.findOneAndUpdate(
    { _id: conversation._id },
    { $max: { unreadCount: 1 } },
    { returnDocument: 'after' },
  ).lean<ConversationDoc>();
  const result = updated ?? conversation;
  emitConversation(result);
  await emitSummary(result.accountId);
  return result;
};

const tokenFor = async (ix: InboxContext, channelId: Types.ObjectId) => {
  const channel = await WhatsAppChannelModel.findById(channelId)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (
    !channel?.tokenSealed ||
    !channel.phoneNumberId ||
    !['connected', 'restricted'].includes(channel.status)
  ) {
    return null;
  }
  return {
    channel,
    token: openSecret(ix.wa, channel.tokenSealed),
    phoneNumberId: channel.phoneNumberId,
  };
};

/** `read.receipt` job: Meta "read" for one customer message. */
export const processReadReceipt = async (
  ix: InboxContext,
  messageId: string,
  options: { finalAttempt: boolean },
): Promise<'sent' | 'skipped'> => {
  const m = await MessageModel.findById(messageId).lean<MessageDoc>();
  if (!m?.waMessageId || m.direction !== 'in') return 'skipped';
  const access = await tokenFor(ix, m.channelId);
  if (!access) return 'skipped';
  try {
    await ix.wa.meta.markRead(access.token, access.phoneNumberId, m.waMessageId);
    return 'sent';
  } catch (err) {
    if (isMetaApiError(err) && err.tokenInvalid) {
      await markNeedsReconnect(ix.wa, access.channel);
      return 'skipped';
    }
    if (isMetaApiError(err) && err.retryable && !options.finalAttempt) throw err;
    getLogger().warn(
      { messageId, code: isMetaApiError(err) ? err.code : null },
      'inbox: read receipt not sent',
    );
    return 'skipped';
  }
};

/**
 * An agent is typing: other agents see it (topic) and — inside the window, when the
 * account sends read receipts (Meta's typing indicator also marks the message read)
 * — the customer sees "typing…". At most once per `typingThrottleMs` per conversation.
 */
export const sendTyping = async (
  ix: InboxContext,
  input: { accountId: Types.ObjectId; user: { id: string; name: string }; conversationId: string },
): Promise<{ sent: boolean }> => {
  const conversation = await findConversation(input.accountId, input.conversationId);
  const fresh = await ix.wa.redis.set(
    `inbox-typing-${conversation._id.toString()}`,
    '1',
    'PX',
    INBOX_LIMITS.typingThrottleMs,
    'NX',
  );
  if (fresh !== 'OK') return { sent: false };
  emitTyping(conversation._id, input.user);
  if (!isWindowOpen(conversation, inboxNow(ix))) return { sent: false };
  const settings = await loadInboxSettings(input.accountId);
  if (!settings.sendReadReceipts) return { sent: false };
  const latest = await latestInbound(conversation._id);
  const access = latest ? await tokenFor(ix, conversation.channelId) : null;
  if (!latest?.waMessageId || !access) return { sent: false };
  try {
    await ix.wa.meta.markRead(access.token, access.phoneNumberId, latest.waMessageId, {
      typing: true,
    });
    return { sent: true };
  } catch (err) {
    getLogger().warn(
      { code: isMetaApiError(err) ? err.code : null },
      'inbox: typing indicator not sent',
    );
    return { sent: false };
  }
};
