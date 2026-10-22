import type { Readable } from 'node:stream';

import { INBOX_LIMITS } from '../../config/limits';
import {
  buildMessagePayload,
  isMetaApiError,
  mapSendError,
  type InteractiveHeaderInput,
  type MetaContactCard,
  type OutboundContent,
} from '../../core/meta';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { openSecret } from '../whatsapp/context';

import { applyChannelEffect } from './channel-effects';
import { inboxNow, type InboxContext } from './context';
import { syncLastMessageStatus } from './conversation-store';
import { emitConversation, emitMessageUpdated } from './events';

export type SendOutcome =
  | { kind: 'accepted'; waMessageId: string }
  | { kind: 'skipped' }
  | { kind: 'failed'; reason: string }
  /** An earlier message of the conversation is still queued — try again shortly. */
  | { kind: 'wait'; delayMs: number }
  /** Meta asked to slow down (pair rate limit) — try again after `delayMs`. */
  | { kind: 'later'; delayMs: number };

/** Thrown for retryable failures (BullMQ retries with backoff). */
export class RetryableSendError extends Error {
  constructor(readonly code: number | null) {
    super(`send failed, will retry (code ${String(code)})`);
    this.name = 'RetryableSendError';
  }
}

class NotSendable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'NotSendable';
  }
}

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const fresh = (uploadedAt: Date | null, now: Date) =>
  Boolean(uploadedAt && now.getTime() - uploadedAt.getTime() < INBOX_LIMITS.metaMediaReuseMs);

/** Uploads a stored file to Meta once (media ids are valid ~30 days) and remembers the id. */
const metaMediaFor = async (
  ix: InboxContext,
  m: MessageDoc,
  token: string,
  phoneNumberId: string,
  part: 'media' | 'header',
  now: Date,
): Promise<string> => {
  const src =
    part === 'media'
      ? m.media
      : m.interactive?.header
        ? { ...m.interactive.header, metaMediaUploadedAt: m.media?.metaMediaUploadedAt ?? null }
        : null;
  if (!src?.storageKey) throw new NotSendable('The file is missing');
  if (src.metaMediaId && fresh(src.metaMediaUploadedAt, now)) return src.metaMediaId;
  let bytes: Buffer;
  try {
    bytes = await readAll(await ix.storage.get(src.storageKey));
  } catch {
    throw new NotSendable('The file is missing');
  }
  const mediaId = await ix.wa.meta.uploadMedia(token, phoneNumberId, {
    bytes,
    mimeType: src.mimeType?.split(';')[0] ?? 'application/octet-stream',
    fileName: src.fileName ?? `file.${src.storageKey.split('.').pop() ?? 'bin'}`,
  });
  const set =
    part === 'media'
      ? { 'media.metaMediaId': mediaId, 'media.metaMediaUploadedAt': now }
      : { 'interactive.header.metaMediaId': mediaId };
  await MessageModel.updateOne({ _id: m._id }, { $set: set });
  return mediaId;
};

const cardsOf = (m: MessageDoc): MetaContactCard[] =>
  (m.contacts ?? []).map((c) => ({
    name: { formatted_name: c.name },
    phones: c.phones.map((p) => ({
      phone: p.phone,
      type: 'CELL' as const,
      ...(p.waId ? { wa_id: p.waId } : {}),
    })),
    ...(c.emails.length
      ? { emails: c.emails.map((e) => ({ email: e.email, type: 'WORK' as const })) }
      : {}),
  }));

/** Stored message → what Meta takes (uploads media first). */
const contentOf = async (
  ix: InboxContext,
  m: MessageDoc,
  token: string,
  phoneNumberId: string,
  now: Date,
): Promise<OutboundContent> => {
  switch (m.type) {
    case 'text':
      return { type: 'text', body: m.text ?? '' };
    case 'image':
    case 'video':
      return {
        type: m.type,
        mediaId: await metaMediaFor(ix, m, token, phoneNumberId, 'media', now),
        caption: m.text,
      };
    case 'audio':
      return {
        type: 'audio',
        mediaId: await metaMediaFor(ix, m, token, phoneNumberId, 'media', now),
      };
    case 'sticker':
      return {
        type: 'sticker',
        mediaId: await metaMediaFor(ix, m, token, phoneNumberId, 'media', now),
      };
    case 'document':
      return {
        type: 'document',
        mediaId: await metaMediaFor(ix, m, token, phoneNumberId, 'media', now),
        caption: m.text,
        fileName: m.media?.fileName ?? 'document',
      };
    case 'location': {
      const l = m.location;
      if (!l) throw new NotSendable('Location missing');
      return {
        type: 'location',
        latitude: l.latitude,
        longitude: l.longitude,
        name: l.name,
        address: l.address,
      };
    }
    case 'contacts':
      return { type: 'contacts', contacts: cardsOf(m) };
    case 'reaction':
      return {
        type: 'reaction',
        messageId: m.reaction?.targetWaMessageId ?? '',
        emoji: m.reaction?.emoji ?? '',
      };
    case 'interactive': {
      const i = m.interactive;
      if (!i) throw new NotSendable('Interactive content missing');
      if (i.kind === 'button') {
        let header: InteractiveHeaderInput | null = null;
        if (i.header?.type === 'text') header = { type: 'text', text: i.header.text ?? '' };
        else if (i.header) {
          const mediaId = await metaMediaFor(ix, m, token, phoneNumberId, 'header', now);
          header =
            i.header.type === 'document'
              ? {
                  type: 'document',
                  mediaId,
                  ...(i.header.fileName ? { fileName: i.header.fileName } : {}),
                }
              : { type: i.header.type, mediaId };
        }
        return {
          type: 'buttons',
          body: i.body ?? '',
          header,
          footer: i.footer,
          buttons: i.buttons,
        };
      }
      if (i.kind === 'list') {
        return {
          type: 'list',
          body: i.body ?? '',
          header: i.header?.text ?? null,
          footer: i.footer,
          button: i.listButton ?? 'Options',
          sections: i.sections,
        };
      }
      if (i.kind === 'cta_url' && i.cta) {
        return {
          type: 'cta_url',
          body: i.body ?? '',
          header: i.header?.text ?? null,
          footer: i.footer,
          displayText: i.cta.displayText,
          url: i.cta.url,
        };
      }
      throw new NotSendable('This interactive message cannot be sent');
    }
    default:
      throw new NotSendable('This message type cannot be sent');
  }
};

const update = async (
  m: MessageDoc,
  filterStatus: MessageDoc['status'],
  set: Record<string, unknown>,
  status: MessageDoc['status'],
  now: Date,
) => {
  const updated = await MessageModel.findOneAndUpdate(
    { _id: m._id, status: filterStatus },
    {
      $set: { ...set, status },
      $push: {
        statusHistory: { $each: [{ status, at: now }], $slice: -INBOX_LIMITS.statusHistoryMax },
      },
    },
    { returnDocument: 'after' },
  ).lean<MessageDoc>();
  if (!updated) return null;
  emitMessageUpdated(updated);
  const conv = await syncLastMessageStatus(updated);
  if (conv) emitConversation(conv);
  return updated;
};

const fail = async (
  m: MessageDoc,
  code: number | null,
  title: string | null,
  reason: string,
  now: Date,
) => {
  await update(m, 'queued', { error: { code, title, reason } }, 'failed', now);
  return { kind: 'failed' as const, reason };
};

/**
 * `message.send` job (PHASE_10_PLAN §1d): only a `queued` message is sent (a restart
 * after Meta accepted it never sends it again); outgoing order per conversation;
 * media uploaded to Meta once; `accepted` + wamid set atomically; Meta errors →
 * retry (thrown), wait (pair rate limit) or `failed` with our reason + channel effects.
 */
export const processSend = async (
  ix: InboxContext,
  messageId: string,
  options: { finalAttempt: boolean; waits: number },
): Promise<SendOutcome> => {
  const m = await MessageModel.findById(messageId).lean<MessageDoc>();
  if (!m || m.status !== 'queued' || m.direction !== 'out') return { kind: 'skipped' };
  const now = inboxNow(ix);
  const earlier = await MessageModel.exists({
    conversationId: m.conversationId,
    direction: 'out',
    status: 'queued',
    type: { $ne: 'note' },
    $or: [{ at: { $lt: m.at } }, { at: m.at, _id: { $lt: m._id } }],
  });
  if (earlier && options.waits < INBOX_LIMITS.orderWaitMaxRetries) {
    return { kind: 'wait', delayMs: INBOX_LIMITS.orderWaitDelayMs };
  }
  if (earlier) getLogger().info({ messageId }, 'inbox: order_wait_exhausted');

  const [conversation, channel] = await Promise.all([
    ConversationModel.findById(m.conversationId).lean<ConversationDoc>(),
    WhatsAppChannelModel.findById(m.channelId).select('+tokenSealed').lean<WhatsAppChannelDoc>(),
  ]);
  try {
    if (!conversation) throw new NotSendable('Conversation not found');
    if (
      !channel?.tokenSealed ||
      !channel.phoneNumberId ||
      !['connected', 'restricted'].includes(channel.status)
    ) {
      throw new NotSendable('The WhatsApp number is not connected');
    }
    if (conversation.blocked) throw new NotSendable('You blocked this customer');
    const token = openSecret(ix.wa, channel.tokenSealed);
    const content = await contentOf(ix, m, token, channel.phoneNumberId, now);
    const payload = buildMessagePayload(
      conversation.waId,
      content,
      m.context?.replyToWaMessageId ?? null,
    );
    const { waMessageId } = await ix.wa.meta.sendMessage(token, channel.phoneNumberId, payload);
    await update(m, 'queued', { waMessageId, error: null }, 'accepted', now);
    return { kind: 'accepted', waMessageId };
  } catch (err) {
    if (err instanceof NotSendable) return fail(m, null, null, err.reason, now);
    if (!isMetaApiError(err)) {
      // our own validation (limits) or a programming error: never retried endlessly
      if (options.finalAttempt || (err as { code?: string }).code === 'VALIDATION_FAILED') {
        return fail(m, null, null, 'Message failed', now);
      }
      throw err;
    }
    const mapped = mapSendError({
      code: err.code,
      status: err.status,
      tokenInvalid: err.tokenInvalid,
      retryable: err.retryable,
    });
    getLogger().warn(
      { messageId, code: err.code, retryable: mapped.retryable, final: options.finalAttempt },
      'inbox: send failed',
    );
    await applyChannelEffect(ix.wa, m.channelId, mapped.channelEffect);
    if (
      mapped.retryable &&
      mapped.retryAfterSec &&
      options.waits < INBOX_LIMITS.orderWaitMaxRetries
    ) {
      return { kind: 'later', delayMs: mapped.retryAfterSec * 1000 };
    }
    if (mapped.retryable && !options.finalAttempt) throw new RetryableSendError(err.code);
    return fail(m, err.code, err.type, mapped.reason, now);
  }
};
