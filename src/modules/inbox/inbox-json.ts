import type { ConversationDoc } from '../../db/models/conversation.model';
import type { MessageDoc } from '../../db/models/message.model';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const id = (v: { toString(): string } | null | undefined): string | null =>
  v ? v.toString() : null;

export interface ReplyToView {
  id: string;
  type: MessageDoc['type'];
  direction: MessageDoc['direction'];
  preview: string;
}

/**
 * A message as the inbox shows it (topic events + API). Never storage keys or Meta
 * media ids — media is fetched through `GET /inbox/messages/:id/media`.
 */
export const toMessageView = (
  m: MessageDoc,
  extra: { replyTo?: ReplyToView | null; sentBy?: { id: string; name: string } | null } = {},
) => ({
  id: m._id.toString(),
  conversationId: m.conversationId.toString(),
  channelId: m.channelId.toString(),
  direction: m.direction,
  origin: m.origin,
  type: m.type,
  text: m.text,
  media: m.media
    ? {
        status: m.media.status,
        mimeType: m.media.mimeType,
        size: m.media.size,
        fileName: m.media.fileName,
        durationSec: m.media.durationSec,
        voice: m.media.voice,
        animated: m.media.animated,
      }
    : null,
  location: m.location,
  contacts: m.contacts,
  interactive: m.interactive
    ? {
        kind: m.interactive.kind,
        header: m.interactive.header
          ? {
              type: m.interactive.header.type,
              text: m.interactive.header.text,
              fileName: m.interactive.header.fileName,
            }
          : null,
        body: m.interactive.body,
        footer: m.interactive.footer,
        buttons: m.interactive.buttons,
        listButton: m.interactive.listButton,
        sections: m.interactive.sections,
        cta: m.interactive.cta,
        reply: m.interactive.reply,
        nfmResponse: m.interactive.nfmResponse,
        nfmTruncated: m.interactive.nfmTruncated,
      }
    : null,
  reaction: m.reaction
    ? { targetMessageId: id(m.reaction.targetMessageId), emoji: m.reaction.emoji }
    : null,
  context: m.context
    ? {
        replyToMessageId: id(m.context.replyToMessageId),
        forwarded: m.context.forwarded,
        frequentlyForwarded: m.context.frequentlyForwarded,
        referral: m.context.referral,
      }
    : null,
  replyTo: extra.replyTo ?? null,
  reactions: m.reactions.map((r) => ({ emoji: r.emoji, by: r.by, at: r.at.toISOString() })),
  order: m.order,
  button: m.button,
  system: m.system,
  status: m.status,
  statusHistory: m.statusHistory.map((s) => ({ status: s.status, at: s.at.toISOString() })),
  error: m.error ? { code: m.error.code, reason: m.error.reason } : null,
  clientId: m.clientId,
  sentBy: extra.sentBy ?? (m.sentBy ? { id: m.sentBy.toString(), name: '' } : null),
  retryOf: id(m.retryOf),
  at: m.at.toISOString(),
  createdAt: m.createdAt.toISOString(),
});
export type MessageView = ReturnType<typeof toMessageView>;

/** Account-level conversation event (ids and counts only — never text). */
export const conversationEvent = (c: ConversationDoc) => ({
  conversationId: c._id.toString(),
  status: c.status,
  unreadCount: c.unreadCount,
  assignedTo: id(c.assignedTo),
  lastMessageAt: iso(c.lastMessage?.at),
  lastMessageDirection: c.lastMessage?.direction ?? null,
});
