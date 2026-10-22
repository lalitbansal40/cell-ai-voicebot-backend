import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { InboxUploadModel, type InboxUploadDoc } from '../../db/models/inbox-upload.model';
import {
  MessageModel,
  type InteractiveHeader,
  type MessageContactCard,
  type MessageDoc,
  type MessageMedia,
} from '../../db/models/message.model';
import { UserModel } from '../../db/models/user.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { withTransaction } from '../../db/transaction';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';

import { inboxNow, type InboxContext } from './context';
import { touchLastMessage } from './conversation-store';
import { emitConversation, emitMessageCreated } from './events';
import { blankContent, insertMessage, type NewMessage } from './message-store';
import type { NormalizedContent } from './normalize';
import type { SendMessageInput } from './outbound.schema';
import { buildPreview } from './preview';
import { applyReaction } from './reactions';

/** Statuses a number can send from (Meta decides for restricted ones and the error maps). */
const SENDABLE = new Set(['connected', 'restricted']);

export interface SendActor {
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
}

const bad = (path: string, message: string) => new ValidationError([{ path, message }]);

/** The 24-hour window: free-form messages only while it is open. */
export const isWindowOpen = (c: Pick<ConversationDoc, 'windowExpiresAt'>, now: Date): boolean =>
  Boolean(c.windowExpiresAt && c.windowExpiresAt > now);

export const assertCanSend = async (
  conversation: ConversationDoc,
  now: Date,
): Promise<WhatsAppChannelDoc> => {
  const channel = await WhatsAppChannelModel.findById(
    conversation.channelId,
  ).lean<WhatsAppChannelDoc>();
  if (!channel || !SENDABLE.has(channel.status)) throw new AppError('WHATSAPP_CHANNEL_NOT_READY');
  if (conversation.blocked) throw new AppError('WHATSAPP_RECIPIENT_BLOCKED');
  if (!isWindowOpen(conversation, now)) {
    throw new AppError('WHATSAPP_WINDOW_CLOSED', undefined, [
      {
        path: 'windowExpiresAt',
        message: conversation.windowExpiresAt
          ? `Closed at ${conversation.windowExpiresAt.toISOString()}`
          : 'The customer has not written yet',
      },
    ]);
  }
  // opted-out customers: replies are allowed inside a window the customer opened —
  // business-initiated messages (templates, Phase 11) will check `optedOutAt`
  return channel;
};

const KIND_FOR: Record<string, InboxUploadDoc['kind'][]> = {
  image: ['image'],
  video: ['video'],
  audio: ['audio', 'voice'],
  voice: ['voice'],
  document: ['document'],
  sticker: ['sticker'],
};

const loadUpload = async (
  actor: SendActor,
  token: string,
  allowed: InboxUploadDoc['kind'][],
  path = 'mediaToken',
  now = new Date(),
): Promise<InboxUploadDoc> => {
  const upload = await InboxUploadModel.findOne({
    _id: new Types.ObjectId(token),
    accountId: actor.accountId,
    userId: actor.userId,
    expiresAt: { $gt: now },
  }).lean<InboxUploadDoc>();
  if (!upload) throw bad(path, 'The upload was not found or has expired — attach the file again');
  if (!allowed.includes(upload.kind)) throw bad(path, `The upload is a ${upload.kind}`);
  return upload;
};

const mediaOf = (u: InboxUploadDoc, fileName?: string | null): MessageMedia => ({
  metaMediaId: null,
  metaMediaUploadedAt: null,
  storageKey: u.storageKey,
  mimeType: u.mimeType,
  size: u.size,
  sha256: u.sha256,
  fileName: fileName?.trim() || u.fileName,
  voice: u.voice,
  durationSec: u.durationSec,
  animated: false,
  status: 'ready',
  error: null,
});

const cardOf = (c: ContactDoc): MessageContactCard => ({
  name: c.name?.trim() || c.phoneE164,
  phones: [{ phone: c.phoneE164, type: 'CELL', waId: c.whatsapp?.waId ?? null }],
  emails: c.email ? [{ email: c.email, type: 'WORK' }] : [],
  org: null,
});

interface Built {
  content: NormalizedContent;
  uploads: InboxUploadDoc[];
  reactionTarget: MessageDoc | null;
}

/** Request body → stored content (+ the uploads it consumes). */
const buildContent = async (
  actor: SendActor,
  conversation: ConversationDoc,
  input: Exclude<SendMessageInput, { type: 'note' }>,
  now: Date,
): Promise<Built> => {
  const uploads: InboxUploadDoc[] = [];
  const empty = (type: NormalizedContent['type']) => blankContent(type);
  switch (input.type) {
    case 'text':
      return { content: { ...empty('text'), text: input.text }, uploads, reactionTarget: null };
    case 'image':
    case 'video':
    case 'audio':
    case 'voice':
    case 'sticker':
    case 'document': {
      const upload = await loadUpload(
        actor,
        input.mediaToken,
        KIND_FOR[input.type] ?? [],
        'mediaToken',
        now,
      );
      uploads.push(upload);
      const type = input.type === 'voice' ? 'audio' : input.type;
      const caption = 'caption' in input ? (input.caption?.trim() ?? null) : null;
      const fileName = input.type === 'document' ? input.fileName : null;
      return {
        content: { ...empty(type), text: caption || null, media: mediaOf(upload, fileName) },
        uploads,
        reactionTarget: null,
      };
    }
    case 'location':
      return {
        content: {
          ...empty('location'),
          location: {
            latitude: input.latitude,
            longitude: input.longitude,
            name: input.name?.trim() || null,
            address: input.address?.trim() || null,
            url: null,
          },
        },
        uploads,
        reactionTarget: null,
      };
    case 'contacts': {
      const ids = input.contactIds.map((id) => new Types.ObjectId(id));
      const contacts = await ContactModel.find({
        _id: { $in: ids },
        accountId: actor.accountId,
        deletedAt: null,
      }).lean<ContactDoc[]>();
      if (contacts.length !== new Set(input.contactIds).size)
        throw bad('contactIds', 'Some contacts were not found');
      const order = new Map(input.contactIds.map((id, i) => [id, i]));
      contacts.sort(
        (a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0),
      );
      return {
        content: { ...empty('contacts'), contacts: contacts.map(cardOf) },
        uploads,
        reactionTarget: null,
      };
    }
    case 'buttons':
    case 'list':
    case 'cta_url': {
      let header: InteractiveHeader | null = null;
      if (input.type === 'buttons' && input.header) {
        if (input.header.type === 'text') {
          header = {
            type: 'text',
            text: input.header.text,
            storageKey: null,
            metaMediaId: null,
            mimeType: null,
            fileName: null,
          };
        } else {
          const upload = await loadUpload(
            actor,
            input.header.mediaToken,
            [input.header.type],
            'header.mediaToken',
            now,
          );
          uploads.push(upload);
          header = {
            type: input.header.type,
            text: null,
            storageKey: upload.storageKey,
            metaMediaId: null,
            mimeType: upload.mimeType,
            fileName: upload.fileName,
          };
        }
      } else if (input.type !== 'buttons' && input.header) {
        header = {
          type: 'text',
          text: input.header,
          storageKey: null,
          metaMediaId: null,
          mimeType: null,
          fileName: null,
        };
      }
      return {
        content: {
          ...empty('interactive'),
          interactive: {
            kind: input.type === 'buttons' ? 'button' : input.type,
            header,
            body: input.body,
            footer: input.footer?.trim() || null,
            buttons: input.type === 'buttons' ? input.buttons : [],
            listButton: input.type === 'list' ? input.button : null,
            sections:
              input.type === 'list'
                ? input.sections.map((s) => ({
                    title: s.title?.trim() || null,
                    rows: s.rows.map((r) => ({
                      id: r.id,
                      title: r.title,
                      description: r.description?.trim() || null,
                    })),
                  }))
                : [],
            cta:
              input.type === 'cta_url' ? { displayText: input.displayText, url: input.url } : null,
            reply: null,
            nfmResponse: null,
            nfmTruncated: false,
          },
        },
        uploads,
        reactionTarget: null,
      };
    }
    case 'reaction': {
      const target = await MessageModel.findOne({
        _id: new Types.ObjectId(input.messageId),
        conversationId: conversation._id,
        accountId: actor.accountId,
      }).lean<MessageDoc>();
      if (!target?.waMessageId || target.type === 'reaction' || target.type === 'note') {
        throw bad('messageId', 'This message cannot be reacted to');
      }
      if (now.getTime() - target.at.getTime() > INBOX_LIMITS.reactionTargetMaxAgeMs) {
        throw bad('messageId', 'Messages older than 30 days cannot be reacted to');
      }
      return {
        content: {
          ...empty('reaction'),
          reaction: {
            targetWaMessageId: target.waMessageId,
            targetMessageId: target._id,
            emoji: input.emoji,
          },
        },
        uploads,
        reactionTarget: target,
      };
    }
  }
};

const replyContext = async (
  conversation: ConversationDoc,
  replyToMessageId: string | undefined,
): Promise<{ context: NormalizedContent['context']; target: MessageDoc | null }> => {
  if (!replyToMessageId) return { context: null, target: null };
  const target = await MessageModel.findOne({
    _id: new Types.ObjectId(replyToMessageId),
    conversationId: conversation._id,
  }).lean<MessageDoc>();
  if (!target?.waMessageId) throw bad('replyToMessageId', 'This message cannot be quoted');
  return {
    context: {
      replyToWaMessageId: target.waMessageId,
      replyToMessageId: target._id,
      forwarded: false,
      frequentlyForwarded: false,
      referral: null,
    },
    target,
  };
};

const senderOf = async (userId: Types.ObjectId) => {
  const user = await UserModel.findById(userId).select({ name: 1 }).lean<{ name: string }>();
  return { id: userId.toString(), name: user?.name ?? '' };
};

const announce = async (
  conversation: ConversationDoc,
  message: MessageDoc,
  extra: { replyTo?: MessageDoc | null; userId?: Types.ObjectId | null },
) => {
  emitMessageCreated(message, {
    replyTo: extra.replyTo
      ? {
          id: extra.replyTo._id.toString(),
          type: extra.replyTo.type,
          direction: extra.replyTo.direction,
          preview: buildPreview(extra.replyTo),
        }
      : null,
    sentBy: extra.userId ? await senderOf(extra.userId) : null,
  });
  if (message.type === 'reaction' || message.type === 'note') return;
  const conv = await touchLastMessage(conversation._id, message);
  if (conv) emitConversation(conv);
};

const findByClientId = (actor: SendActor, clientId: string) =>
  MessageModel.findOne({ accountId: actor.accountId, clientId }).lean<MessageDoc>();

/**
 * Sends a message / writes a note (PHASE_10_PLAN §1d): checks, idempotency by
 * `clientId` (a retry returns the same message, `created: false`), stores it
 * `queued`, consumes the upload(s) in the same transaction, queues the send job.
 */
export const sendMessage = async (
  ix: InboxContext,
  actor: SendActor,
  conversationId: string,
  input: SendMessageInput,
): Promise<{ message: MessageDoc; created: boolean }> => {
  const conversation = await ConversationModel.findOne({
    _id: new Types.ObjectId(conversationId),
    accountId: actor.accountId,
  }).lean<ConversationDoc>();
  if (!conversation) throw new NotFoundError('Conversation not found');
  const existing = await findByClientId(actor, input.clientId);
  if (existing) {
    if (!existing.conversationId.equals(conversation._id)) {
      throw new AppError('CONFLICT_DUPLICATE', 'This client id was used for another message', [
        { path: 'clientId', message: 'Already used' },
      ]);
    }
    return { message: existing, created: false };
  }
  const now = inboxNow(ix);

  if (input.type === 'note') {
    try {
      const note = await insertMessage(conversation, {
        ...blankContent('note'),
        text: input.text,
        direction: 'out',
        origin: 'agent',
        status: 'sent',
        sentBy: actor.userId,
        clientId: input.clientId,
        at: now,
      });
      await announce(conversation, note, { userId: actor.userId });
      return { message: note, created: true };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const raced = await findByClientId(actor, input.clientId);
      if (!raced) throw err;
      return { message: raced, created: false };
    }
  }

  await assertCanSend(conversation, now);
  const built = await buildContent(actor, conversation, input, now);
  const reply = await replyContext(conversation, input.replyToMessageId);
  const doc: NewMessage = {
    ...built.content,
    context: input.type === 'reaction' ? null : reply.context,
    direction: 'out',
    origin: 'agent',
    status: 'queued',
    sentBy: actor.userId,
    clientId: input.clientId,
    at: now,
    statusHistory: [{ status: 'queued', at: now }],
  };
  let message: MessageDoc;
  try {
    message = await withTransaction(async (session) => {
      const [created] = await MessageModel.create(
        [
          {
            accountId: conversation.accountId,
            conversationId: conversation._id,
            channelId: conversation.channelId,
            contactId: conversation.contactId,
            ...doc,
          },
        ],
        { session },
      );
      if (built.uploads.length) {
        const res = await InboxUploadModel.deleteMany(
          { _id: { $in: built.uploads.map((u) => u._id) } },
          { session },
        );
        // a parallel send consumed the same upload first
        if (res.deletedCount !== built.uploads.length)
          throw bad('mediaToken', 'The upload was already sent');
      }
      return (created as unknown as { toObject(o: object): MessageDoc }).toObject({
        transform: false,
      });
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await findByClientId(actor, input.clientId);
    if (!raced) throw err;
    return { message: raced, created: false };
  }
  if (built.reactionTarget) {
    await applyReaction(
      built.reactionTarget,
      'agent',
      input.type === 'reaction' ? input.emoji : '',
      now,
      actor.userId,
    );
  }
  if (conversation.status === 'closed') {
    const reopened = await ConversationModel.findOneAndUpdate(
      { _id: conversation._id },
      { $set: { status: 'open', closedAt: null, closedBy: null } },
      { returnDocument: 'after' },
    ).lean<ConversationDoc>();
    if (reopened) emitConversation(reopened);
  }
  await announce(conversation, message, { replyTo: reply.target, userId: actor.userId });
  await ix.jobs.enqueueSend(message._id.toString());
  return { message, created: true };
};

/** A failed outgoing message sent again as a new message (`retryOf`), window re-checked. */
export const retryMessage = async (
  ix: InboxContext,
  actor: SendActor,
  messageId: string,
): Promise<MessageDoc> => {
  const failed = await MessageModel.findOne({
    _id: new Types.ObjectId(messageId),
    accountId: actor.accountId,
  }).lean<MessageDoc>();
  if (!failed) throw new NotFoundError('Message not found');
  if (failed.direction !== 'out' || failed.status !== 'failed' || failed.type === 'note') {
    throw new AppError('CONFLICT_INVALID_STATE', 'Only failed messages can be retried');
  }
  const conversation = await ConversationModel.findById(
    failed.conversationId,
  ).lean<ConversationDoc>();
  if (!conversation) throw new NotFoundError('Conversation not found');
  const now = inboxNow(ix);
  await assertCanSend(conversation, now);
  const already = await MessageModel.findOne({
    retryOf: failed._id,
    status: { $ne: 'failed' },
  }).lean<MessageDoc>();
  if (already) return already;
  const {
    _id: _old,
    createdAt: _c,
    updatedAt: _u,
    waMessageId: _w,
    error: _e,
    pricing: _p,
    statusHistory: _s,
    clientId: _ci,
    ...content
  } = failed;
  const message = await insertMessage(conversation, {
    ...(content as unknown as NewMessage),
    status: 'queued',
    sentBy: actor.userId,
    retryOf: failed._id,
    clientId: randomUUID(),
    at: now,
    statusHistory: [{ status: 'queued', at: now }],
    media: failed.media ? { ...failed.media, status: 'ready', error: null } : null,
  });
  await announce(conversation, message, { userId: actor.userId });
  await ix.jobs.enqueueSend(message._id.toString());
  return message;
};

/**
 * Our own text to the customer (opt-out / opt-in confirmations): `origin: system`,
 * no sender, queued for the send job. Only inside the customer service window
 * (the keyword that triggers it just opened it). Returns null when the window is closed.
 */
export const queueSystemText = async (
  ix: InboxContext,
  conversation: ConversationDoc,
  text: string,
): Promise<MessageDoc | null> => {
  const now = inboxNow(ix);
  if (!isWindowOpen(conversation, now)) return null;
  const message = await insertMessage(conversation, {
    ...blankContent('text'),
    text,
    direction: 'out',
    origin: 'system',
    status: 'queued',
    at: now,
    statusHistory: [{ status: 'queued', at: now }],
  });
  emitMessageCreated(message);
  const conv = await touchLastMessage(conversation._id, message);
  if (conv) emitConversation(conv);
  await ix.jobs.enqueueSend(message._id.toString());
  return message;
};
