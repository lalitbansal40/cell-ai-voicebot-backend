import { INBOX_LIMITS } from '../../config/limits';
import { inboundMessageSchema, metaTime, type InboundMessage } from '../../core/meta';
import type {
  MessageContactCard,
  MessageContext,
  MessageDoc,
  MessageMedia,
  MessageType,
} from '../../db/models/message.model';

/** The content fields of a message built from a Meta message (no ids / routing). */
export type NormalizedContent = Pick<
  MessageDoc,
  | 'type'
  | 'text'
  | 'media'
  | 'location'
  | 'contacts'
  | 'interactive'
  | 'reaction'
  | 'context'
  | 'order'
  | 'button'
  | 'system'
  | 'error'
>;

export interface NormalizedInbound {
  waMessageId: string;
  /** Customer's WhatsApp id (digits). Echoes: the `to`. */
  from: string;
  to: string | null;
  metaTimestamp: Date | null;
  content: NormalizedContent;
  /** Meta media id to download (image / video / audio / document / sticker). */
  mediaId: string | null;
  /** The parsed Meta message (null when it didn't match the documented shape). */
  raw: InboundMessage | null;
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
const isMediaType = (t: string): t is MediaType => (MEDIA_TYPES as readonly string[]).includes(t);

const clip = (value: string | null | undefined, max: number): string | null =>
  value === null || value === undefined || value === '' ? null : value.slice(0, max);

const digits = (value: string | null | undefined): string => value?.replace(/\D/g, '') ?? '';

/** Last 4 digits for system lines ("changed their number to •••• 0909"). */
export const last4 = (value: string | null | undefined): string | null => {
  const d = digits(value);
  return d ? d.slice(-4) : null;
};

const emptyContent = (type: MessageType): NormalizedContent => ({
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

const mediaOf = (m: NonNullable<InboundMessage['image']>, mimeFallback: string): MessageMedia => ({
  metaMediaId: m.id,
  metaMediaUploadedAt: null,
  storageKey: null,
  mimeType: clip(m.mime_type, 120) ?? mimeFallback,
  size: null,
  sha256: clip(m.sha256, 200),
  fileName: clip(m.filename?.replace(/[\\/]/g, '_'), INBOX_LIMITS.fileNameMax),
  voice: Boolean(m.voice),
  durationSec: null,
  animated: Boolean(m.animated),
  status: 'pending',
  error: null,
});

const MIME_FALLBACK: Record<MediaType, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

const contactsOf = (cards: NonNullable<InboundMessage['contacts']>): MessageContactCard[] =>
  cards.slice(0, INBOX_LIMITS.contactsMax).map((c) => ({
    name:
      clip(c.name?.formatted_name, 256) ??
      clip([c.name?.first_name, c.name?.last_name].filter(Boolean).join(' '), 256) ??
      'Contact',
    phones: (c.phones ?? [])
      .filter((p) => p.phone || p.wa_id)
      .slice(0, 10)
      .map((p) => ({
        phone: clip(p.phone ?? p.wa_id, 40) ?? '',
        type: clip(p.type, 40),
        waId: clip(digits(p.wa_id), 20),
      })),
    emails: (c.emails ?? [])
      .filter((e) => e.email)
      .slice(0, 10)
      .map((e) => ({ email: clip(e.email, 254) ?? '', type: clip(e.type, 40) })),
    org: clip(c.org?.company, 256),
  }));

const contextOf = (msg: InboundMessage): MessageContext | null => {
  const c = msg.context;
  const r = msg.referral;
  if (!c && !r) return null;
  return {
    replyToWaMessageId: clip(c?.id, 200),
    replyToMessageId: null,
    forwarded: Boolean(c?.forwarded || c?.frequently_forwarded),
    frequentlyForwarded: Boolean(c?.frequently_forwarded),
    referral: r
      ? {
          sourceUrl: clip(r.source_url, 2000),
          sourceType: clip(r.source_type, 40),
          sourceId: clip(r.source_id, 100),
          headline: clip(r.headline, 1000),
          body: clip(r.body, 2000),
          ctwaClid: clip(r.ctwa_clid, 500),
        }
      : null,
  };
};

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Meta message → our content fields (PHASE_10_PLAN §1c). Pure. */
export const normalizeContent = (
  msg: InboundMessage,
): { content: NormalizedContent; mediaId: string | null } => {
  const type = msg.type;
  const ctx = contextOf(msg);
  if (isMediaType(type) && msg[type]) {
    const m = msg[type];
    return {
      content: {
        ...emptyContent(type),
        text: clip(m.caption, INBOX_LIMITS.captionMax),
        media: mediaOf(m, MIME_FALLBACK[type]),
        context: ctx,
      },
      mediaId: m.id,
    };
  }
  switch (type) {
    case 'text':
      if (msg.text) {
        return {
          content: {
            ...emptyContent('text'),
            text: clip(msg.text.body, INBOX_LIMITS.textMax) ?? '',
            context: ctx,
          },
          mediaId: null,
        };
      }
      break;
    case 'location':
      if (msg.location) {
        return {
          content: {
            ...emptyContent('location'),
            location: {
              latitude: msg.location.latitude,
              longitude: msg.location.longitude,
              name: clip(msg.location.name, 1000),
              address: clip(msg.location.address, 1000),
              url: clip(msg.location.url, 2000),
            },
            context: ctx,
          },
          mediaId: null,
        };
      }
      break;
    case 'contacts':
      if (msg.contacts?.length) {
        return {
          content: {
            ...emptyContent('contacts'),
            contacts: contactsOf(msg.contacts),
            context: ctx,
          },
          mediaId: null,
        };
      }
      break;
    case 'interactive': {
      const i = msg.interactive;
      const reply = i?.button_reply ?? i?.list_reply;
      if (i && (i.type === 'button_reply' || i.type === 'list_reply') && reply) {
        return {
          content: {
            ...emptyContent('interactive'),
            interactive: {
              kind: i.type,
              header: null,
              body: null,
              footer: null,
              buttons: [],
              listButton: null,
              sections: [],
              cta: null,
              reply: {
                id: clip(reply.id, 256),
                title: clip(reply.title, 256),
                description: clip(i.list_reply?.description, 256),
              },
              nfmResponse: null,
              nfmTruncated: false,
            },
            context: ctx,
          },
          mediaId: null,
        };
      }
      if (i?.type === 'nfm_reply' && i.nfm_reply) {
        const response = i.nfm_reply.response_json ?? '';
        const truncated = Buffer.byteLength(response) > INBOX_LIMITS.nfmResponseMaxBytes;
        return {
          content: {
            ...emptyContent('interactive'),
            interactive: {
              kind: 'nfm_reply',
              header: null,
              body: clip(i.nfm_reply.body, INBOX_LIMITS.textMax),
              footer: null,
              buttons: [],
              listButton: null,
              sections: [],
              cta: null,
              reply: { id: null, title: clip(i.nfm_reply.name, 256), description: null },
              nfmResponse: truncated
                ? Buffer.from(response).subarray(0, INBOX_LIMITS.nfmResponseMaxBytes).toString()
                : response || null,
              nfmTruncated: truncated,
            },
            context: ctx,
          },
          mediaId: null,
        };
      }
      break;
    }
    case 'button':
      if (msg.button) {
        return {
          content: {
            ...emptyContent('button'),
            text: clip(msg.button.text, 256),
            button: { payload: clip(msg.button.payload, 1000), text: clip(msg.button.text, 256) },
            context: ctx,
          },
          mediaId: null,
        };
      }
      break;
    case 'reaction':
      if (msg.reaction) {
        return {
          content: {
            ...emptyContent('reaction'),
            reaction: {
              targetWaMessageId: msg.reaction.message_id,
              targetMessageId: null,
              emoji: msg.reaction.emoji ?? '',
            },
          },
          mediaId: null,
        };
      }
      break;
    case 'order':
      if (msg.order) {
        const items = msg.order.product_items ?? [];
        const total = items.reduce((sum, it) => {
          const price = num(it.item_price);
          const qty = num(it.quantity) ?? 1;
          return price === null ? sum : sum + price * qty;
        }, 0);
        return {
          content: {
            ...emptyContent('order'),
            text: clip(msg.order.text, INBOX_LIMITS.textMax),
            order: {
              catalogId: clip(msg.order.catalog_id, 200),
              itemsCount: items.reduce((n, it) => n + (num(it.quantity) ?? 1), 0),
              total: items.length ? total : null,
              currency: clip(items[0]?.currency, 3),
            },
          },
          mediaId: null,
        };
      }
      break;
    case 'system':
      if (msg.system) {
        return {
          content: {
            ...emptyContent('system'),
            system: {
              kind: clip(msg.system.type, 60) ?? 'system',
              newWaIdLast4: last4(msg.system.new_wa_id ?? msg.system.wa_id),
            },
          },
          mediaId: null,
        };
      }
      break;
    default:
      break;
  }
  const err = msg.errors?.[0];
  return {
    content: {
      ...emptyContent('unsupported'),
      context: ctx,
      error: {
        code: err?.code ?? null,
        title: clip(err?.title, 300),
        reason: "This message type isn't supported yet",
      },
    },
    mediaId: null,
  };
};

/**
 * One raw Meta message → normalized. A message that doesn't match Meta's documented
 * shape is kept as `unsupported` when its id / sender / time can be read; else null.
 */
export const normalizeInbound = (raw: unknown): NormalizedInbound | null => {
  const parsed = inboundMessageSchema.safeParse(raw);
  if (parsed.success) {
    const msg = parsed.data;
    const { content, mediaId } = normalizeContent(msg);
    return {
      waMessageId: msg.id,
      from: digits(msg.from),
      to: msg.to ? digits(msg.to) : null,
      metaTimestamp: metaTime(msg.timestamp),
      content,
      mediaId,
      raw: msg,
    };
  }
  const loose = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = typeof loose.id === 'string' ? loose.id : null;
  const from = typeof loose.from === 'string' ? digits(loose.from) : '';
  if (!id || !from) return null;
  const ts =
    typeof loose.timestamp === 'string' || typeof loose.timestamp === 'number'
      ? loose.timestamp
      : null;
  return {
    waMessageId: id,
    from,
    to: typeof loose.to === 'string' ? digits(loose.to) : null,
    metaTimestamp: metaTime(ts),
    content: {
      ...emptyContent('unsupported'),
      error: { code: null, title: null, reason: "This message type isn't supported yet" },
    },
    mediaId: null,
    raw: null,
  };
};
