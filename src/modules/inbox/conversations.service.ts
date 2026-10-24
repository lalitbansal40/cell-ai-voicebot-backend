import { Types, type QueryFilter } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { isMetaApiError } from '../../core/meta';
import { CallModel } from '../../db/models/call.model';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import { UserModel } from '../../db/models/user.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import { markNeedsReconnect } from '../whatsapp/channel-status';
import { openSecret } from '../whatsapp/context';

import { inboxNow, type InboxContext } from './context';
import { upsertConversation } from './conversation-store';
import { emitConversation } from './events';
import { toMessageView, type ReplyToView } from './inbox-json';
import { contactLabel, inboxLink } from './notify';
import { isWindowOpen } from './outbound.service';
import { buildPreview } from './preview';

const oid = (id: string) => new Types.ObjectId(id);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface InboxActor extends AuditActorInput {
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  ip?: string | null;
}

const audit = (
  actor: InboxActor,
  action: AuditAction,
  conversation: ConversationDoc,
  meta: Record<string, unknown> = {},
) =>
  recordAudit({
    accountId: actor.accountId,
    actor: { type: actor.type, id: actor.id, impersonatorId: actor.impersonatorId ?? null },
    action,
    target: { type: 'conversation', id: conversation._id.toString() },
    meta: { channelId: conversation.channelId.toString(), ...meta },
    ip: actor.ip ?? null,
  });

/* ── views ── */

interface Lookups {
  contacts: Map<string, ContactDoc>;
  users: Map<string, string>;
}

const loadLookups = async (rows: ConversationDoc[]): Promise<Lookups> => {
  const contactIds = [...new Set(rows.map((r) => r.contactId.toString()))].map(oid);
  const userIds = [
    ...new Set(rows.flatMap((r) => (r.assignedTo ? [r.assignedTo.toString()] : []))),
  ].map(oid);
  const [contacts, users] = await Promise.all([
    ContactModel.find({ _id: { $in: contactIds } }, null, { withDeleted: true }).lean<
      ContactDoc[]
    >(),
    UserModel.find({ _id: { $in: userIds } })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
  ]);
  return {
    contacts: new Map(contacts.map((c) => [c._id.toString(), c])),
    users: new Map(users.map((u) => [u._id.toString(), u.name])),
  };
};

export const conversationRow = (c: ConversationDoc, l: Lookups, now: Date) => {
  const contact = l.contacts.get(c.contactId.toString()) ?? null;
  return {
    id: c._id.toString(),
    channelId: c.channelId.toString(),
    contact: {
      id: c.contactId.toString(),
      name: contact?.name ?? null,
      phoneE164: contact?.phoneE164 ?? c.phoneE164,
      deleted: Boolean(contact?.deletedAt) || !contact,
      optedOut: Boolean(contact?.optedOutAt),
    },
    label: contactLabel(contact, c.phoneE164),
    phoneE164: c.phoneE164,
    profileName: c.profileName,
    status: c.status,
    assignedTo: c.assignedTo
      ? { id: c.assignedTo.toString(), name: l.users.get(c.assignedTo.toString()) ?? '' }
      : null,
    unreadCount: c.unreadCount,
    lastMessage: c.lastMessage
      ? {
          id: c.lastMessage.id.toString(),
          direction: c.lastMessage.direction,
          type: c.lastMessage.type,
          preview: c.lastMessage.preview,
          at: c.lastMessage.at.toISOString(),
          status: c.lastMessage.status,
        }
      : null,
    windowExpiresAt: iso(c.windowExpiresAt),
    windowOpen: isWindowOpen(c, now),
    blocked: c.blocked,
    source: c.source,
    closedAt: iso(c.closedAt),
    createdAt: c.createdAt.toISOString(),
  };
};
export type ConversationRow = ReturnType<typeof conversationRow>;

const findConversation = async (actor: Pick<InboxActor, 'accountId'>, id: string) => {
  const c = await ConversationModel.findOne({
    _id: oid(id),
    accountId: actor.accountId,
  }).lean<ConversationDoc>();
  if (!c) throw new NotFoundError('Conversation not found');
  return c;
};

/* ── list / search ── */

export interface ListInput {
  status: 'open' | 'closed';
  filter: 'all' | 'unread' | 'mine' | 'unassigned';
  channelId?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

const encodeCursor = (c: ConversationDoc) =>
  Buffer.from(`${iso(c.lastMessage?.at) ?? ''}|${c._id.toString()}`).toString('base64url');

const decodeCursor = (cursor: string): { at: Date | null; id: Types.ObjectId } => {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!id || !Types.ObjectId.isValid(id) || (at && Number.isNaN(Date.parse(at)))) {
    throw new ValidationError([{ path: 'cursor', message: 'Invalid cursor' }]);
  }
  return { at: at ? new Date(at) : null, id: oid(id) };
};

/** First hit of a search term in `text` with ~80 characters around it. */
export const snippetOf = (text: string, q: string): string => {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length);
  const start = Math.max(0, (at === text.length ? 0 : at) - 30);
  const out = text
    .slice(start, start + 80)
    .replace(/\s+/g, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${out}${start + 80 < text.length ? '…' : ''}`;
};

export const listConversations = async (ix: InboxContext, actor: InboxActor, input: ListInput) => {
  const filter: QueryFilter<ConversationDoc> = { accountId: actor.accountId, status: input.status };
  if (input.filter === 'unread') filter.unreadCount = { $gt: 0 };
  if (input.filter === 'mine') filter.assignedTo = actor.userId;
  if (input.filter === 'unassigned') filter.assignedTo = null;
  if (input.channelId) filter.channelId = oid(input.channelId);
  const matches = new Map<string, { messageId: string; snippet: string }>();
  if (input.q) {
    const q = input.q.trim();
    const digits = q.replace(/\D/g, '');
    const contactIds = await ContactModel.find({
      accountId: actor.accountId,
      searchText: { $regex: escapeRegex(q.toLowerCase()) },
    })
      .select({ _id: 1 })
      .limit(500)
      .lean<{ _id: Types.ObjectId }[]>();
    const hits = await MessageModel.find(
      { accountId: actor.accountId, $text: { $search: q } },
      { score: { $meta: 'textScore' }, conversationId: 1, text: 1 },
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(INBOX_LIMITS.conversationsPageMax * 4)
      .lean<{ _id: Types.ObjectId; conversationId: Types.ObjectId; text: string | null }[]>();
    for (const h of hits) {
      const key = h.conversationId.toString();
      if (!matches.has(key) && h.text)
        matches.set(key, { messageId: h._id.toString(), snippet: snippetOf(h.text, q) });
    }
    filter.$or = [
      { contactId: { $in: contactIds.map((c) => c._id) } },
      { _id: { $in: [...matches.keys()].map(oid) } },
      ...(digits.length >= 4 ? [{ waId: { $regex: escapeRegex(digits) } }] : []),
    ];
  }
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    const page = c.at
      ? [
          { 'lastMessage.at': { $lt: c.at } },
          { 'lastMessage.at': c.at, _id: { $lt: c.id } },
          { lastMessage: null },
        ]
      : [{ lastMessage: null, _id: { $lt: c.id } }];
    filter.$and = [...(filter.$and ?? []), { $or: page }];
  }
  const rows = await ConversationModel.find(filter)
    .sort({ 'lastMessage.at': -1, _id: -1 })
    .limit(input.limit + 1)
    .lean<ConversationDoc[]>();
  const page = rows.slice(0, input.limit);
  const lookups = await loadLookups(page);
  const now = inboxNow(ix);
  return {
    items: page.map((c) => ({
      ...conversationRow(c, lookups, now),
      match: matches.get(c._id.toString()) ?? null,
    })),
    nextCursor:
      rows.length > input.limit && page.length
        ? encodeCursor(page[page.length - 1] as ConversationDoc)
        : null,
  };
};

/* ── detail / messages / contact panel ── */

const channelView = (ch: WhatsAppChannelDoc | null) =>
  ch
    ? {
        id: ch._id.toString(),
        label: ch.label,
        displayPhoneNumber: ch.displayPhoneNumber,
        status: ch.status,
        mode: ch.mode,
      }
    : null;

export const getConversation = async (ix: InboxContext, actor: InboxActor, id: string) => {
  const c = await findConversation(actor, id);
  const [lookups, channel] = await Promise.all([
    loadLookups([c]),
    WhatsAppChannelModel.findById(c.channelId).lean<WhatsAppChannelDoc>(),
  ]);
  return {
    ...conversationRow(c, lookups, inboxNow(ix)),
    channel: channelView(channel),
    lastReadAt: iso(c.lastReadAt),
  };
};

export interface MessagesInput {
  before?: string | undefined;
  around?: string | undefined;
  limit: number;
}

const messageCursor = (m: MessageDoc) =>
  Buffer.from(`${m.at.toISOString()}|${m._id.toString()}`).toString('base64url');

/**
 * Message views with their reply quotes and sender names (list pages and the
 * send / retry responses — the same shape as `inbox.message.created`).
 */
export const messageViews = async (actor: Pick<InboxActor, 'accountId'>, items: MessageDoc[]) => {
  const replyIds = [
    ...new Set(
      items.flatMap((m) =>
        m.context?.replyToMessageId ? [m.context.replyToMessageId.toString()] : [],
      ),
    ),
  ];
  const senderIds = [...new Set(items.flatMap((m) => (m.sentBy ? [m.sentBy.toString()] : [])))];
  const [quoted, senders] = await Promise.all([
    MessageModel.find({ _id: { $in: replyIds.map(oid) }, accountId: actor.accountId }).lean<
      MessageDoc[]
    >(),
    UserModel.find({ _id: { $in: senderIds.map(oid) } })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
  ]);
  const quotes = new Map<string, ReplyToView>(
    quoted.map((q) => [
      q._id.toString(),
      { id: q._id.toString(), type: q.type, direction: q.direction, preview: buildPreview(q) },
    ]),
  );
  const names = new Map(senders.map((u) => [u._id.toString(), u.name]));
  return items.map((m) =>
    toMessageView(m, {
      replyTo: m.context?.replyToMessageId
        ? (quotes.get(m.context.replyToMessageId.toString()) ?? null)
        : null,
      sentBy: m.sentBy
        ? { id: m.sentBy.toString(), name: names.get(m.sentBy.toString()) ?? '' }
        : null,
    }),
  );
};

/** Messages oldest → newest; `before` pages back, `around` centres on a message (jump to a reply). */
export const listMessages = async (
  _ix: InboxContext,
  actor: InboxActor,
  id: string,
  input: MessagesInput,
) => {
  const c = await findConversation(actor, id);
  const base: QueryFilter<MessageDoc> = {
    accountId: actor.accountId,
    conversationId: c._id,
    type: { $ne: 'reaction' },
  };
  let items: MessageDoc[];
  let hasOlder: boolean;
  let hasNewer = false;
  if (input.around) {
    const target = await MessageModel.findOne({
      ...base,
      _id: oid(input.around),
    }).lean<MessageDoc>();
    if (!target) throw new NotFoundError('Message not found');
    const half = Math.floor(input.limit / 2);
    const older = await MessageModel.find({
      ...base,
      $or: [{ at: { $lt: target.at } }, { at: target.at, _id: { $lt: target._id } }],
    })
      .sort({ at: -1, _id: -1 })
      .limit(half + 1)
      .lean<MessageDoc[]>();
    const newer = await MessageModel.find({
      ...base,
      $or: [{ at: { $gt: target.at } }, { at: target.at, _id: { $gt: target._id } }],
    })
      .sort({ at: 1, _id: 1 })
      .limit(half + 1)
      .lean<MessageDoc[]>();
    hasOlder = older.length > half;
    hasNewer = newer.length > half;
    items = [...older.slice(0, half).reverse(), target, ...newer.slice(0, half)];
  } else {
    const filter: QueryFilter<MessageDoc> = { ...base };
    if (input.before) {
      const [at, mid] = Buffer.from(input.before, 'base64url').toString('utf8').split('|');
      if (!at || !mid || !Types.ObjectId.isValid(mid) || Number.isNaN(Date.parse(at))) {
        throw new ValidationError([{ path: 'before', message: 'Invalid cursor' }]);
      }
      filter.$or = [{ at: { $lt: new Date(at) } }, { at: new Date(at), _id: { $lt: oid(mid) } }];
    }
    const rows = await MessageModel.find(filter)
      .sort({ at: -1, _id: -1 })
      .limit(input.limit + 1)
      .lean<MessageDoc[]>();
    hasOlder = rows.length > input.limit;
    items = rows.slice(0, input.limit).reverse();
  }
  // reply quotes + sender names in two queries
  return {
    items: await messageViews(actor, items),
    olderCursor: hasOlder && items[0] ? messageCursor(items[0]) : null,
    hasNewer,
  };
};

export const getContactPanel = async (ix: InboxContext, actor: InboxActor, id: string) => {
  const c = await findConversation(actor, id);
  const contact = await ContactModel.findOne(
    { _id: c.contactId, accountId: actor.accountId },
    null,
    { withDeleted: true },
  ).lean<ContactDoc>();
  const [lists, calls, others] = await Promise.all([
    contact?.listIds.length
      ? ContactListModel.find({ _id: { $in: contact.listIds }, accountId: actor.accountId })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : Promise.resolve([]),
    CallModel.find({ accountId: actor.accountId, contactId: c.contactId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select({ status: 1, createdAt: 1, durationSec: 1, disposition: 1 })
      .lean<
        {
          _id: Types.ObjectId;
          status: string;
          createdAt: Date;
          durationSec?: number | null;
          disposition?: string | null;
        }[]
      >(),
    ConversationModel.find({
      accountId: actor.accountId,
      contactId: c.contactId,
      _id: { $ne: c._id },
    })
      .limit(10)
      .lean<ConversationDoc[]>(),
  ]);
  const channels = await WhatsAppChannelModel.find({ _id: { $in: others.map((o) => o.channelId) } })
    .select({ label: 1 })
    .lean<{ _id: Types.ObjectId; label: string }[]>();
  const labels = new Map(channels.map((ch) => [ch._id.toString(), ch.label]));
  return {
    contact: contact
      ? {
          id: contact._id.toString(),
          name: contact.name ?? null,
          phoneE164: contact.phoneE164,
          email: contact.email ?? null,
          tags: contact.tags,
          lists: lists.map((l) => ({ id: l._id.toString(), name: l.name })),
          variables: Object.fromEntries(
            contact.variables instanceof Map
              ? contact.variables
              : Object.entries(contact.variables ?? {}),
          ),
          dnd: contact.dnd,
          optedOutAt: iso(contact.optedOutAt),
          deleted: Boolean(contact.deletedAt),
          whatsapp: contact.whatsapp
            ? {
                profileName: contact.whatsapp.profileName,
                lastInboundAt: iso(contact.whatsapp.lastInboundAt),
                blocked: contact.whatsapp.blocked,
              }
            : null,
        }
      : null,
    recentCalls: calls.map((call) => ({
      id: call._id.toString(),
      status: call.status,
      at: call.createdAt.toISOString(),
      durationSec: call.durationSec ?? null,
      disposition: call.disposition ?? null,
    })),
    /** Phase 12: WhatsApp call permission state (null without the calling module / contact). */
    callPermission:
      ix.calling && contact && !contact.deletedAt
        ? await ix.calling
            .permissionPanel({
              accountId: actor.accountId,
              channelId: c.channelId,
              contactId: contact._id,
            })
            .catch(() => null)
        : null,
    otherConversations: others.map((o) => ({
      id: o._id.toString(),
      channelId: o.channelId.toString(),
      channelLabel: labels.get(o.channelId.toString()) ?? '',
      lastMessageAt: iso(o.lastMessage?.at),
      status: o.status,
    })),
  };
};

/* ── actions ── */

const changed = async (c: ConversationDoc, set: Record<string, unknown>) => {
  const updated = await ConversationModel.findOneAndUpdate(
    { _id: c._id },
    { $set: set },
    { returnDocument: 'after' },
  ).lean<ConversationDoc>();
  if (!updated) throw new NotFoundError('Conversation not found');
  emitConversation(updated);
  return updated;
};

/** Assign (`inbox.assign`), or take / drop it yourself (`inbox.reply`). The assignee must be able to read the inbox. */
export const assignConversation = async (
  ix: InboxContext,
  actor: InboxActor & { canAssignOthers: boolean },
  id: string,
  assignedTo: string | null,
) => {
  const c = await findConversation(actor, id);
  const self = actor.userId.toString();
  if (!actor.canAssignOthers) {
    const ownDrop = assignedTo === null && c.assignedTo?.toString() === self;
    if (assignedTo !== self && !ownDrop)
      throw new AppError('AUTH_FORBIDDEN', 'You can only assign conversations to yourself');
  }
  if (assignedTo) {
    const readers = await usersWithPermission(actor.accountId, 'inbox.read');
    if (!readers.some((r) => r.userId.toString() === assignedTo)) {
      throw new ValidationError([
        { path: 'assignedTo', message: 'This user cannot use the inbox' },
      ]);
    }
  }
  if ((c.assignedTo?.toString() ?? null) === assignedTo) return getConversation(ix, actor, id);
  const updated = await changed(c, { assignedTo: assignedTo ? oid(assignedTo) : null });
  await audit(actor, 'inbox.conversation_assigned', updated, { assignedTo });
  if (assignedTo && assignedTo !== self) {
    const contact = await ContactModel.findById(updated.contactId, null, {
      withDeleted: true,
    }).lean<ContactDoc>();
    await notify({
      accountId: actor.accountId,
      userIds: [oid(assignedTo)],
      type: 'inbox.conversation_assigned',
      title: 'Conversation assigned to you',
      body: contactLabel(contact, updated.phoneE164),
      link: inboxLink(updated),
    });
  }
  return getConversation(ix, actor, id);
};

export const setConversationStatus = async (
  ix: InboxContext,
  actor: InboxActor,
  id: string,
  status: 'open' | 'closed',
) => {
  const c = await findConversation(actor, id);
  if (c.status === status) return getConversation(ix, actor, id);
  const updated = await changed(
    c,
    status === 'closed'
      ? { status, closedAt: inboxNow(ix), closedBy: actor.userId }
      : { status, closedAt: null, closedBy: null },
  );
  await audit(
    actor,
    status === 'closed' ? 'inbox.conversation_closed' : 'inbox.conversation_reopened',
    updated,
  );
  return getConversation(ix, actor, id);
};

const channelAccess = async (ix: InboxContext, channelId: Types.ObjectId) => {
  const channel = await WhatsAppChannelModel.findById(channelId)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (
    !channel?.tokenSealed ||
    !channel.phoneNumberId ||
    !['connected', 'restricted'].includes(channel.status)
  ) {
    throw new AppError('WHATSAPP_CHANNEL_NOT_READY');
  }
  return {
    channel,
    token: openSecret(ix.wa, channel.tokenSealed),
    phoneNumberId: channel.phoneNumberId,
  };
};

/** Block / unblock the customer on WhatsApp (Block Users API — only after a message in the last 24 h). */
export const setBlocked = async (
  ix: InboxContext,
  actor: InboxActor,
  id: string,
  blocked: boolean,
) => {
  const c = await findConversation(actor, id);
  if (c.blocked === blocked) return getConversation(ix, actor, id);
  const access = await channelAccess(ix, c.channelId);
  let result;
  try {
    result = blocked
      ? await ix.wa.meta.blockUsers(access.token, access.phoneNumberId, [c.waId])
      : await ix.wa.meta.unblockUsers(access.token, access.phoneNumberId, [c.waId]);
  } catch (err) {
    if (isMetaApiError(err) && err.tokenInvalid) await markNeedsReconnect(ix.wa, access.channel);
    throw new AppError('META_API_ERROR', undefined, [
      { path: 'meta', message: isMetaApiError(err) ? `code ${String(err.code)}` : 'unavailable' },
    ]);
  }
  if (result.failed.length) {
    throw new AppError(
      'CONFLICT_INVALID_STATE',
      blocked
        ? 'You can only block customers who messaged you in the last 24 hours'
        : "WhatsApp couldn't unblock this customer",
    );
  }
  const updated = await changed(c, { blocked });
  await ContactModel.updateOne(
    { _id: updated.contactId, accountId: actor.accountId, whatsapp: { $ne: null } },
    { $set: { 'whatsapp.blocked': blocked } },
  );
  await audit(actor, blocked ? 'inbox.contact_blocked' : 'inbox.contact_unblocked', updated);
  return getConversation(ix, actor, id);
};

/** Opens (or creates) the conversation of a contact on a number (Contact page → Start chat). */
export const startConversation = async (
  ix: InboxContext,
  actor: InboxActor,
  input: { channelId: string; contactId: string },
) => {
  const [channel, contact] = await Promise.all([
    WhatsAppChannelModel.findOne({
      _id: oid(input.channelId),
      accountId: actor.accountId,
      status: { $in: WA_ACTIVE_STATUSES },
    }).lean<WhatsAppChannelDoc>(),
    ContactModel.findOne({
      _id: oid(input.contactId),
      accountId: actor.accountId,
      deletedAt: null,
    }).lean<ContactDoc>(),
  ]);
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  if (!contact) throw new NotFoundError('Contact not found');
  const waId = contact.phoneE164.replace(/\D/g, '');
  const existing = await ConversationModel.findOne({
    accountId: actor.accountId,
    channelId: channel._id,
    waId,
  }).lean<ConversationDoc>();
  const conv =
    existing ??
    (await upsertConversation({
      key: { accountId: actor.accountId, channelId: channel._id, waId },
      contactId: contact._id,
      source: 'outbound',
    }));
  if (!existing) emitConversation(conv);
  return { ...(await getConversation(ix, actor, conv._id.toString())), created: !existing };
};

export const inboxSummary = async (actor: InboxActor) => {
  const [unreadConversations, assignedToMeUnread, open] = await Promise.all([
    ConversationModel.countDocuments({
      accountId: actor.accountId,
      status: 'open',
      unreadCount: { $gt: 0 },
    }),
    ConversationModel.countDocuments({
      accountId: actor.accountId,
      status: 'open',
      assignedTo: actor.userId,
      unreadCount: { $gt: 0 },
    }),
    ConversationModel.countDocuments({ accountId: actor.accountId, status: 'open' }),
  ]);
  return { unreadConversations, assignedToMeUnread, open };
};

export const findMessage = async (actor: Pick<InboxActor, 'accountId'>, id: string) => {
  const m = await MessageModel.findOne({
    _id: oid(id),
    accountId: actor.accountId,
  }).lean<MessageDoc>();
  if (!m) throw new NotFoundError('Message not found');
  return m;
};
