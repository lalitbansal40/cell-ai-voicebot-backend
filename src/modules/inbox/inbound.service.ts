import type { Types } from 'mongoose';

import { inboxMessagesValueSchema } from '../../core/meta';
import { isDuplicateKeyError } from '../../db/errors';
import {
  AccountModel,
  DEFAULT_INBOX_SETTINGS,
  type AccountInboxSettings,
} from '../../db/models/account.model';
import type { ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { WebhookSchemaError } from '../whatsapp/webhook-handlers';

import { findOrCreateWhatsAppContact } from './contacts';
import { inboxNow, type InboxContext } from './context';
import { touchLastMessage, upsertConversation } from './conversation-store';
import { emitConversation, emitMessageCreated, emitSummary } from './events';
import type { ReplyToView } from './inbox-json';
import { insertMessage } from './message-store';
import { normalizeInbound, type NormalizedInbound } from './normalize';
import { notifyNewMessage } from './notify';
import { handleKeywords } from './optout.service';
import { buildPreview } from './preview';
import { applyReaction } from './reactions';
import { applyStatuses, type StatusResult } from './status.service';

export interface InboundResult {
  messages: number;
  duplicates: number;
  skipped: number;
  statuses: StatusResult;
}

export const loadInboxSettings = async (
  accountId: Types.ObjectId,
): Promise<AccountInboxSettings> => {
  const account = await AccountModel.findById(accountId)
    .select({ 'settings.inbox': 1 })
    .lean<{ settings?: { inbox?: Partial<AccountInboxSettings> } }>();
  return { ...DEFAULT_INBOX_SETTINGS, ...account?.settings?.inbox };
};

const replyToView = (m: MessageDoc): ReplyToView => ({
  id: m._id.toString(),
  type: m.type,
  direction: m.direction,
  preview: buildPreview(m),
});

/** The message a reply / reaction points at (same number), if we have it. */
const findByWamid = (channel: WhatsAppChannelDoc, waMessageId: string | null) =>
  waMessageId
    ? MessageModel.findOne({
        accountId: channel.accountId,
        channelId: channel._id,
        waMessageId,
      }).lean<MessageDoc>()
    : Promise.resolve(null);

/**
 * One customer message (PHASE_10_PLAN §1c / §1g): dedupe by wamid → contact (match /
 * create) → conversation (reopen, window, unread) → message → reply / reaction links
 * → media download job → keywords → live events + bell.
 */
export const processCustomerMessage = async (
  ix: InboxContext,
  input: {
    channel: WhatsAppChannelDoc;
    message: NormalizedInbound;
    profileName: string | null;
    settings: AccountInboxSettings;
  },
): Promise<'created' | 'duplicate' | 'skipped'> => {
  const { channel, message: n, settings } = input;
  if (!n.from) return 'skipped';
  const exists = await MessageModel.exists({
    accountId: channel.accountId,
    channelId: channel._id,
    waMessageId: n.waMessageId,
  });
  if (exists) return 'duplicate';
  const at = n.metaTimestamp ?? inboxNow(ix);
  const type = n.content.type;
  // a system line (number changed) or a reaction is not "unread"
  const countUnread = type !== 'reaction' && type !== 'system';
  const opensWindow = type !== 'system';
  const contact = await findOrCreateWhatsAppContact({
    accountId: channel.accountId,
    waId: n.from,
    profileName: input.profileName,
    inboundAt: opensWindow ? at : null,
  });
  let conversation: ConversationDoc = await upsertConversation({
    key: { accountId: channel.accountId, channelId: channel._id, waId: n.from },
    contactId: contact._id,
    source: 'inbound',
    profileName: input.profileName,
    inbound: opensWindow ? { at, countUnread } : null,
  });

  const content = { ...n.content };
  let replyTo: MessageDoc | null = null;
  if (content.context?.replyToWaMessageId) {
    replyTo = await findByWamid(channel, content.context.replyToWaMessageId);
    if (replyTo) content.context = { ...content.context, replyToMessageId: replyTo._id };
  }
  let target: MessageDoc | null = null;
  if (content.reaction) {
    target = await findByWamid(channel, content.reaction.targetWaMessageId);
    if (target) content.reaction = { ...content.reaction, targetMessageId: target._id };
  }
  let stored: MessageDoc;
  try {
    stored = await insertMessage(conversation, {
      ...content,
      direction: 'in',
      origin: 'customer',
      status: 'received',
      waMessageId: n.waMessageId,
      metaTimestamp: n.metaTimestamp,
      at,
    });
  } catch (err) {
    // Meta delivered the same message twice at once — the other one won
    if (isDuplicateKeyError(err)) return 'duplicate';
    throw err;
  }
  if (target && content.reaction) {
    await applyReaction(target, 'customer', content.reaction.emoji, at);
  }
  if (type !== 'reaction') {
    emitMessageCreated(stored, { replyTo: replyTo ? replyToView(replyTo) : null });
    conversation = (await touchLastMessage(conversation._id, stored)) ?? conversation;
  }
  if (n.mediaId) await ix.jobs.enqueueMediaDownload(stored._id.toString());
  const permission = stored.interactive?.callPermission;
  if (ix.calling && stored.interactive?.kind === 'call_permission_reply' && permission) {
    await ix.calling.onPermissionReply({
      channel,
      contactId: contact._id,
      reply: {
        response: permission.response,
        isPermanent: permission.isPermanent,
        expiresAt: permission.expiresAt,
        source: permission.source,
      },
      contextId: permission.requestWaMessageId,
      at,
    });
  }
  emitConversation(conversation);
  await emitSummary(conversation.accountId);
  const keywordText =
    type === 'text' || type === 'button'
      ? stored.text
      : type === 'interactive'
        ? (stored.interactive?.reply?.title ?? null)
        : null;
  await handleKeywords(ix, { settings, conversation, contact, text: keywordText, at });
  if (countUnread) {
    await notifyNewMessage(ix, { conversation, contact, mode: settings.notifyOnNewMessage });
  }
  return 'created';
};

/** `messages` webhook value for one channel: customer messages + statuses. */
export const processMessagesValue = async (
  ix: InboxContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<InboundResult> => {
  const parsed = inboxMessagesValueSchema.safeParse(value);
  if (!parsed.success) throw new WebhookSchemaError('messages');
  const v = parsed.data;
  const result: InboundResult = {
    messages: 0,
    duplicates: 0,
    skipped: 0,
    statuses: { applied: 0, ignored: 0, unknown: 0 },
  };
  const rawMessages = v.messages ?? [];
  if (rawMessages.length) {
    const settings = await loadInboxSettings(channel.accountId);
    const names = new Map(
      (v.contacts ?? []).map((c) => [c.wa_id.replace(/\D/g, ''), c.profile?.name ?? null]),
    );
    for (const raw of rawMessages) {
      const n = normalizeInbound(raw);
      if (!n) {
        result.skipped += 1;
        continue;
      }
      const outcome = await processCustomerMessage(ix, {
        channel,
        message: n,
        profileName: names.get(n.from) ?? null,
        settings,
      });
      if (outcome === 'created') result.messages += 1;
      else if (outcome === 'duplicate') result.duplicates += 1;
      else result.skipped += 1;
    }
  }
  if (v.statuses?.length) result.statuses = await applyStatuses(ix, channel, v.statuses);
  if (v.errors?.length || result.skipped) {
    getLogger().warn(
      {
        channelId: channel._id.toString(),
        errors: v.errors?.map((e) => e.code ?? null) ?? [],
        skipped: result.skipped,
      },
      'inbox: messages webhook had errors / unreadable messages',
    );
  }
  return result;
};
