import { INBOX_LIMITS } from '../../config/limits';
import { ValidationError, type ErrorDetail } from '../../shared/errors/app-error';

import type { MetaMessagePayload } from './types';

/** A contact card as Meta takes it (`contacts[]`). */
export interface MetaContactCard {
  name: { formatted_name: string; first_name?: string };
  phones: { phone: string; type: 'CELL'; wa_id?: string }[];
  emails?: { email: string; type: 'WORK' }[];
  org?: { company: string };
}

export type InteractiveHeaderInput =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video'; mediaId: string }
  | { type: 'document'; mediaId: string; fileName?: string };

/** What the outbound pipeline sends (media already uploaded → Meta media ids). */
export type OutboundContent =
  | { type: 'text'; body: string; previewUrl?: boolean }
  | { type: 'image' | 'video'; mediaId: string; caption?: string | null }
  | { type: 'audio'; mediaId: string }
  | { type: 'document'; mediaId: string; caption?: string | null; fileName: string }
  | { type: 'sticker'; mediaId: string }
  | {
      type: 'location';
      latitude: number;
      longitude: number;
      name?: string | null;
      address?: string | null;
    }
  | { type: 'contacts'; contacts: MetaContactCard[] }
  | {
      type: 'buttons';
      body: string;
      header?: InteractiveHeaderInput | null;
      footer?: string | null;
      buttons: { id: string; title: string }[];
    }
  | {
      type: 'list';
      body: string;
      header?: string | null;
      footer?: string | null;
      button: string;
      sections: {
        title?: string | null;
        rows: { id: string; title: string; description?: string | null }[];
      }[];
    }
  | {
      type: 'cta_url';
      body: string;
      header?: string | null;
      footer?: string | null;
      displayText: string;
      url: string;
    }
  /** `emoji: ''` removes the reaction. */
  | { type: 'reaction'; messageId: string; emoji: string };

const URL_IN_TEXT = /https?:\/\/\S/i;

/** Limit checks again right before Meta (defence in depth — the API schema checks first). */
const check = (content: OutboundContent): ErrorDetail[] => {
  const L = INBOX_LIMITS;
  const errors: ErrorDetail[] = [];
  const len = (path: string, value: string | null | undefined, max: number, min = 0) => {
    const n = value?.length ?? 0;
    if (n < min || n > max)
      errors.push({ path, message: `Must be ${String(min)}–${String(max)} characters` });
  };
  switch (content.type) {
    case 'text':
      len('text', content.body, L.textMax, 1);
      break;
    case 'image':
    case 'video':
    case 'document':
      len('caption', content.caption, L.captionMax);
      if (content.type === 'document') len('fileName', content.fileName, L.fileNameMax, 1);
      break;
    case 'location':
      if (!(Math.abs(content.latitude) <= 90))
        errors.push({ path: 'latitude', message: 'Out of range' });
      if (!(Math.abs(content.longitude) <= 180))
        errors.push({ path: 'longitude', message: 'Out of range' });
      break;
    case 'contacts':
      if (content.contacts.length < 1 || content.contacts.length > L.contactsMax)
        errors.push({ path: 'contacts', message: `1–${String(L.contactsMax)} contacts` });
      break;
    case 'buttons':
      len('body', content.body, L.bodyMax, 1);
      len('footer', content.footer, L.footerMax);
      if (content.header?.type === 'text') len('header', content.header.text, L.headerTextMax, 1);
      if (content.buttons.length < 1 || content.buttons.length > L.buttonsMax)
        errors.push({ path: 'buttons', message: `1–${String(L.buttonsMax)} buttons` });
      content.buttons.forEach((b, i) => {
        len(`buttons.${String(i)}.title`, b.title, L.buttonTitleMax, 1);
        len(`buttons.${String(i)}.id`, b.id, L.buttonIdMax, 1);
      });
      if (new Set(content.buttons.map((b) => b.id)).size !== content.buttons.length)
        errors.push({ path: 'buttons', message: 'Button ids must be unique' });
      break;
    case 'list': {
      len('body', content.body, L.bodyMax, 1);
      len('footer', content.footer, L.footerMax);
      len('header', content.header, L.headerTextMax);
      len('button', content.button, L.listButtonMax, 1);
      const rows = content.sections.flatMap((s) => s.rows);
      if (content.sections.length < 1 || content.sections.length > L.listSectionsMax)
        errors.push({ path: 'sections', message: `1–${String(L.listSectionsMax)} sections` });
      if (rows.length < 1 || rows.length > L.listRowsMax)
        errors.push({ path: 'sections', message: `1–${String(L.listRowsMax)} rows in total` });
      if (new Set(rows.map((r) => r.id)).size !== rows.length)
        errors.push({ path: 'sections', message: 'Row ids must be unique' });
      content.sections.forEach((s, i) => {
        len(`sections.${String(i)}.title`, s.title, L.sectionTitleMax);
        s.rows.forEach((r, j) => {
          len(`sections.${String(i)}.rows.${String(j)}.title`, r.title, L.rowTitleMax, 1);
          len(
            `sections.${String(i)}.rows.${String(j)}.description`,
            r.description,
            L.rowDescriptionMax,
          );
        });
      });
      break;
    }
    case 'cta_url':
      len('body', content.body, L.bodyMax, 1);
      len('footer', content.footer, L.footerMax);
      len('header', content.header, L.headerTextMax);
      len('displayText', content.displayText, L.ctaTextMax, 1);
      if (!/^https:\/\/[^\s]+$/i.test(content.url))
        errors.push({ path: 'url', message: 'Must be an https:// link' });
      break;
    case 'reaction':
      if ([...content.emoji].length > 8) errors.push({ path: 'emoji', message: 'One emoji' });
      break;
    default:
      break;
  }
  return errors;
};

const text = (value: string) => ({ text: value });
const opt = <K extends string, V>(key: K, value: V | null | undefined) =>
  value === null || value === undefined || value === '' ? {} : ({ [key]: value } as Record<K, V>);

const header = (h: InteractiveHeaderInput | string | null | undefined) => {
  if (!h) return {};
  if (typeof h === 'string') return { header: { type: 'text', text: h } };
  if (h.type === 'text') return { header: { type: 'text', text: h.text } };
  if (h.type === 'document') {
    return {
      header: { type: 'document', document: { id: h.mediaId, ...opt('filename', h.fileName) } },
    };
  }
  return { header: { type: h.type, [h.type]: { id: h.mediaId } } };
};

const body = (content: OutboundContent): Record<string, unknown> => {
  switch (content.type) {
    case 'text':
      return {
        text: {
          body: content.body,
          preview_url: content.previewUrl ?? URL_IN_TEXT.test(content.body),
        },
      };
    case 'image':
    case 'video':
      return { [content.type]: { id: content.mediaId, ...opt('caption', content.caption) } };
    case 'audio':
      return { audio: { id: content.mediaId } };
    case 'document':
      return {
        document: {
          id: content.mediaId,
          ...opt('caption', content.caption),
          filename: content.fileName,
        },
      };
    case 'sticker':
      return { sticker: { id: content.mediaId } };
    case 'location':
      return {
        location: {
          latitude: content.latitude,
          longitude: content.longitude,
          ...opt('name', content.name),
          ...opt('address', content.address),
        },
      };
    case 'contacts':
      return { contacts: content.contacts };
    case 'buttons':
      return {
        interactive: {
          type: 'button',
          ...header(content.header),
          body: text(content.body),
          ...(content.footer ? { footer: text(content.footer) } : {}),
          action: {
            buttons: content.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    case 'list':
      return {
        interactive: {
          type: 'list',
          ...header(content.header),
          body: text(content.body),
          ...(content.footer ? { footer: text(content.footer) } : {}),
          action: {
            button: content.button,
            sections: content.sections.map((s) => ({
              ...opt('title', s.title),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...opt('description', r.description),
              })),
            })),
          },
        },
      };
    case 'cta_url':
      return {
        interactive: {
          type: 'cta_url',
          ...header(content.header),
          body: text(content.body),
          ...(content.footer ? { footer: text(content.footer) } : {}),
          action: {
            name: 'cta_url',
            parameters: { display_text: content.displayText, url: content.url },
          },
        },
      };
    case 'reaction':
      return { reaction: { message_id: content.messageId, emoji: content.emoji } };
  }
};

/** Meta's type name for the content (`buttons` / `list` / `cta_url` → `interactive`). */
export const metaTypeOf = (content: OutboundContent): string =>
  content.type === 'buttons' || content.type === 'list' || content.type === 'cta_url'
    ? 'interactive'
    : content.type;

/**
 * Exact `POST /{phone}/messages` body (Cloud API reference). `to` = the customer's
 * WhatsApp id (digits); `replyTo` = the wamid quoted (`context.message_id`).
 */
export const buildMessagePayload = (
  to: string,
  content: OutboundContent,
  replyTo?: string | null,
): MetaMessagePayload => {
  const errors = check(content);
  if (!/^\d{6,20}$/.test(to)) errors.push({ path: 'to', message: 'Not a WhatsApp id' });
  if (errors.length) throw new ValidationError(errors);
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: metaTypeOf(content),
    ...(replyTo && content.type !== 'reaction' ? { context: { message_id: replyTo } } : {}),
    ...body(content),
  };
};

/** A Phase 3 contact → Meta contact card (`wa_id` when the number is on WhatsApp). */
export const contactToMetaCard = (contact: {
  name?: string | null;
  phoneE164: string;
  email?: string | null;
  waId?: string | null;
}): MetaContactCard => ({
  name: { formatted_name: contact.name?.trim() || contact.phoneE164 },
  phones: [{ phone: contact.phoneE164, type: 'CELL', ...opt('wa_id', contact.waId) }],
  ...(contact.email ? { emails: [{ email: contact.email, type: 'WORK' as const }] } : {}),
});
