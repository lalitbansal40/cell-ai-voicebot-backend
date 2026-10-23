import { INBOX_LIMITS } from '../../config/limits';
import type { MessageDoc, MessageType } from '../../db/models/message.model';

/** List-row labels for messages without text (PHASE_10_PLAN §1p). */
export const TYPE_LABELS: Record<MessageType, string> = {
  text: 'Message',
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker',
  location: 'Location',
  contacts: 'Contact',
  interactive: 'Interactive message',
  button: 'Button reply',
  reaction: 'Reaction',
  order: 'Order',
  system: 'System message',
  unsupported: 'Unsupported message',
  note: 'Internal note',
  template: 'Template',
};

type PreviewSource = Pick<
  MessageDoc,
  'type' | 'text' | 'media' | 'contacts' | 'interactive' | 'reaction' | 'location'
>;

/** One-line preview for the conversation list (customer data — never logged). */
export const buildPreview = (m: PreviewSource): string => {
  const out = (value: string) =>
    value.replace(/\s+/g, ' ').trim().slice(0, INBOX_LIMITS.previewMax);
  switch (m.type) {
    case 'audio':
      return m.media?.voice ? 'Voice note' : 'Audio';
    case 'document':
      return out(m.text || m.media?.fileName || 'Document');
    case 'contacts':
      return out(m.contacts?.[0]?.name ? `Contact: ${m.contacts[0].name}` : 'Contact');
    case 'location':
      return out(m.location?.name ? `Location: ${m.location.name}` : 'Location');
    case 'interactive': {
      const i = m.interactive;
      if (!i) return TYPE_LABELS.interactive;
      if (i.kind === 'button_reply' || i.kind === 'list_reply')
        return out(`Replied: ${i.reply?.title ?? ''}`);
      if (i.kind === 'nfm_reply') return 'Form submitted';
      return out(i.body || TYPE_LABELS.interactive);
    }
    case 'reaction':
      return m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : 'Removed a reaction';
    case 'system':
    case 'unsupported':
      return TYPE_LABELS[m.type];
    default:
      return out(m.text || TYPE_LABELS[m.type]);
  }
};
