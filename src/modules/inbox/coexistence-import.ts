import { INBOX_LIMITS } from '../../config/limits';
import {
  inboxEchoesValueSchema,
  inboxHistoryValueSchema,
  inboxStateSyncValueSchema,
} from '../../core/meta';
import { isDuplicateKeyError } from '../../db/errors';
import { ContactModel } from '../../db/models/contact.model';
import type { ConversationDoc } from '../../db/models/conversation.model';
import type { MessageStatus } from '../../db/models/message.model';
import { MessageModel } from '../../db/models/message.model';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';
import { markConsumed } from '../whatsapp/deferred-events';
import { openPayload, WebhookSchemaError } from '../whatsapp/webhook-handlers';

import { findOrCreateWhatsAppContact } from './contacts';
import { inboxNow, type InboxContext } from './context';
import { touchLastMessage, upsertConversation } from './conversation-store';
import { emitConversation, emitMessageCreated } from './events';
import { insertMessage } from './message-store';
import { normalizeInbound, type NormalizedInbound } from './normalize';
import { applyReaction } from './reactions';

const digits = (v: string | null | undefined) => v?.replace(/\D/g, '') ?? '';

/** Days kept (`INBOX_RETENTION_DAYS`; 0 = forever) → the oldest time worth importing. */
export const retentionCutoff = (ix: InboxContext): Date | null => {
  const days = ix.wa.env.INBOX_RETENTION_DAYS;
  return days > 0 ? new Date(inboxNow(ix).getTime() - days * 86_400_000) : null;
};

const insertOnce = async (
  conversation: ConversationDoc,
  n: NormalizedInbound,
  base: {
    direction: 'in' | 'out';
    origin: 'business_app' | 'history';
    status: MessageStatus;
    at: Date;
  },
) => {
  try {
    return await insertMessage(conversation, {
      ...n.content,
      ...base,
      waMessageId: n.waMessageId,
      metaTimestamp: n.metaTimestamp,
      statusHistory: base.direction === 'out' ? [{ status: base.status, at: base.at }] : [],
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
};

/**
 * `smb_message_echoes` (PHASE_10_PLAN §1h): what the business sent from the WhatsApp
 * Business app → outgoing messages `origin: business_app`, status `sent`. The
 * window is not refreshed (only customers open it); no unread, no bell.
 */
export const processEchoes = async (
  ix: InboxContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<{ messages: number; duplicates: number }> => {
  const parsed = inboxEchoesValueSchema.safeParse(value);
  if (!parsed.success) throw new WebhookSchemaError('smb_message_echoes');
  let messages = 0;
  let duplicates = 0;
  for (const raw of parsed.data.message_echoes) {
    const n = normalizeInbound(raw);
    const customer = digits(n?.to);
    if (!n || !customer) continue;
    const exists = await MessageModel.exists({
      accountId: channel.accountId,
      channelId: channel._id,
      waMessageId: n.waMessageId,
    });
    if (exists) {
      duplicates += 1;
      continue;
    }
    const at = n.metaTimestamp ?? inboxNow(ix);
    const contact = await findOrCreateWhatsAppContact({
      accountId: channel.accountId,
      waId: customer,
    });
    const conversation = await upsertConversation({
      key: { accountId: channel.accountId, channelId: channel._id, waId: customer },
      contactId: contact._id,
      source: 'business_app',
    });
    if (n.content.type === 'reaction' && n.content.reaction) {
      const target = await MessageModel.findOne({
        accountId: channel.accountId,
        channelId: channel._id,
        waMessageId: n.content.reaction.targetWaMessageId,
      }).lean();
      if (target) await applyReaction(target, 'agent', n.content.reaction.emoji, at);
    }
    const stored = await insertOnce(conversation, n, {
      direction: 'out',
      origin: 'business_app',
      status: 'sent',
      at,
    });
    if (!stored) {
      duplicates += 1;
      continue;
    }
    messages += 1;
    if (n.mediaId) await ix.jobs.enqueueMediaDownload(stored._id.toString());
    if (stored.type !== 'reaction') {
      emitMessageCreated(stored);
      const conv = await touchLastMessage(conversation._id, stored);
      if (conv) emitConversation(conv);
    }
  }
  return { messages, duplicates };
};

/** `smb_app_state_sync` contacts: add → create / name (unless a person named it); remove → mark only. */
export const processStateSync = async (
  ix: InboxContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<{ added: number; removed: number }> => {
  const parsed = inboxStateSyncValueSchema.safeParse(value);
  if (!parsed.success) throw new WebhookSchemaError('smb_app_state_sync');
  let added = 0;
  let removed = 0;
  for (const item of parsed.data.state_sync) {
    const waId = digits(item.contact?.phone_number);
    if (item.type !== 'contact' || waId.length < 6) continue;
    if ((item.action ?? 'add') === 'remove') {
      const res = await ContactModel.updateOne(
        {
          accountId: channel.accountId,
          phoneE164: `+${waId}`,
          deletedAt: null,
          whatsapp: { $ne: null },
        },
        { $set: { 'whatsapp.syncRemovedAt': inboxNow(ix) } },
      );
      removed += res.modifiedCount;
      continue;
    }
    await findOrCreateWhatsAppContact({
      accountId: channel.accountId,
      waId,
      bookName: item.contact?.full_name ?? item.contact?.first_name ?? null,
    });
    added += 1;
  }
  return { added, removed };
};

const HISTORY_STATUS: Record<string, MessageStatus> = {
  READ: 'read',
  PLAYED: 'read',
  DELIVERED: 'delivered',
  SENT: 'sent',
  PENDING: 'sent',
  ERROR: 'failed',
  FAILED: 'failed',
};

export interface HistoryImportResult {
  conversations: number;
  messages: number;
  duplicates: number;
  skippedOld: number;
}

const counterKey = (channelId: string) => `inbox-history-${channelId}`;

/**
 * `inbox.history-import` job: one `history` webhook event (threads of past chats) →
 * conversations `source: history` + messages `origin: history` (no unread, no bell,
 * no keywords), older than the retention cutoff skipped, deduped by wamid. The final
 * chunk (progress 100) writes one audit entry with the totals. The event is then consumed.
 */
export const importHistoryEvent = async (
  ix: InboxContext,
  eventId: string,
): Promise<HistoryImportResult | null> => {
  const event = await MetaWebhookEventModel.findById(eventId).select('+payloadSealed').lean<{
    _id: { toString(): string };
    status: string;
    channelId: unknown;
    payloadSealed: string;
  }>();
  if (!event || event.status !== 'deferred' || !event.channelId) return null;
  const channel = await WhatsAppChannelModel.findById(event.channelId).lean<WhatsAppChannelDoc>();
  if (!channel || channel.status === 'disconnected') return null;
  const parsed = inboxHistoryValueSchema.safeParse(openPayload(ix.wa, event.payloadSealed));
  if (!parsed.success) throw new WebhookSchemaError('history');
  const cutoff = retentionCutoff(ix);
  const result: HistoryImportResult = {
    conversations: 0,
    messages: 0,
    duplicates: 0,
    skippedOld: 0,
  };
  let final = false;
  for (const chunk of parsed.data.history) {
    if ((chunk.metadata?.progress ?? 0) >= 100) final = true;
    if (chunk.errors?.length) continue;
    for (const thread of chunk.threads ?? []) {
      const customer = digits(thread.id);
      if (customer.length < 6) continue;
      let conversation: ConversationDoc | null = null;
      for (const raw of thread.messages ?? []) {
        const n = normalizeInbound(raw);
        if (!n) continue;
        const at = n.metaTimestamp ?? inboxNow(ix);
        if (cutoff && at < cutoff) {
          result.skippedOld += 1;
          continue;
        }
        if (!conversation) {
          const contact = await findOrCreateWhatsAppContact({
            accountId: channel.accountId,
            waId: customer,
          });
          conversation = await upsertConversation({
            key: { accountId: channel.accountId, channelId: channel._id, waId: customer },
            contactId: contact._id,
            source: 'history',
          });
          result.conversations += 1;
        }
        const fromCustomer = n.from === customer;
        const status = fromCustomer
          ? 'received'
          : (HISTORY_STATUS[String(n.raw?.history_context?.status ?? '').toUpperCase()] ?? 'sent');
        const stored = await insertOnce(conversation, n, {
          direction: fromCustomer ? 'in' : 'out',
          origin: 'history',
          status,
          at,
        });
        if (!stored) {
          result.duplicates += 1;
          continue;
        }
        result.messages += 1;
        if (n.mediaId && inboxNow(ix).getTime() - at.getTime() < INBOX_LIMITS.inboundMediaValidMs) {
          await ix.jobs.enqueueMediaDownload(stored._id.toString());
        }
        if (stored.type !== 'reaction') {
          const conv = await touchLastMessage(conversation._id, stored);
          if (conv) conversation = conv;
        }
      }
      if (conversation) emitConversation(conversation);
    }
  }
  const key = counterKey(channel._id.toString());
  const redis = ix.wa.redis;
  await redis.hincrby(key, 'conversations', result.conversations);
  await redis.hincrby(key, 'messages', result.messages);
  await redis.hincrby(key, 'duplicates', result.duplicates);
  await redis.hincrby(key, 'skippedOld', result.skippedOld);
  await redis.expire(key, 30 * 86_400);
  if (final) {
    const totals = await redis.hgetall(key);
    await redis.del(key);
    await recordAudit({
      accountId: channel.accountId,
      actor: { type: 'system', id: null },
      action: 'inbox.history_imported',
      target: { type: 'whatsapp_channel', id: channel._id.toString() },
      meta: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])),
    });
  }
  await markConsumed(ix.wa, [eventId]);
  getLogger().info(
    { channelId: channel._id.toString(), ...result, final },
    'inbox: history chunk imported',
  );
  return result;
};
