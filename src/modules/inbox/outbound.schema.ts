import { INBOX_LIMITS as L } from '../../config/limits';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

/**
 * `POST /inbox/conversations/:id/messages` bodies — one per type (PHASE_10_PLAN §1d).
 * Media types reference an upload (`mediaToken` = the upload id from `POST /inbox/media`).
 */
const clientId = z
  .uuid({ message: 'Must be a UUID' })
  .openapi({ example: '6f1c2b8e-9d1a-4c55-8a3e-2b1f0c9d7e61' });
const replyToMessageId = ObjectIdSchema.optional();
const mediaToken = ObjectIdSchema;
const text = (max: number, min = 1) => z.string().trim().min(min).max(max);
const optText = (max: number) => z.string().trim().max(max).optional().nullable();

const base = { clientId, replyToMessageId };

export const TextBody = z.object({
  ...base,
  type: z.literal('text'),
  text: text(L.textMax),
  previewUrl: z.boolean().optional(),
});
const MediaWithCaption = (type: 'image' | 'video') =>
  z.object({ ...base, type: z.literal(type), mediaToken, caption: optText(L.captionMax) });
export const ImageBody = MediaWithCaption('image');
export const VideoBody = MediaWithCaption('video');
export const AudioBody = z.object({ ...base, type: z.literal('audio'), mediaToken });
export const VoiceBody = z.object({ ...base, type: z.literal('voice'), mediaToken });
export const DocumentBody = z.object({
  ...base,
  type: z.literal('document'),
  mediaToken,
  caption: optText(L.captionMax),
  fileName: optText(L.fileNameMax),
});
export const StickerBody = z.object({ ...base, type: z.literal('sticker'), mediaToken });
export const LocationBody = z.object({
  ...base,
  type: z.literal('location'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: optText(1000),
  address: optText(1000),
});
export const ContactsBody = z.object({
  ...base,
  type: z.literal('contacts'),
  contactIds: z.array(ObjectIdSchema).min(1).max(L.contactsMax),
});

const ButtonHeader = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: text(L.headerTextMax) }),
  z.object({ type: z.enum(['image', 'video', 'document']), mediaToken }),
]);
const uniqueBy = <T>(items: T[], key: (t: T) => string) =>
  new Set(items.map(key)).size === items.length;

export const ButtonsBody = z.object({
  ...base,
  type: z.literal('buttons'),
  body: text(L.bodyMax),
  header: ButtonHeader.optional().nullable(),
  footer: optText(L.footerMax),
  buttons: z
    .array(z.object({ id: text(L.buttonIdMax), title: text(L.buttonTitleMax) }))
    .min(1)
    .max(L.buttonsMax)
    .refine((b) => uniqueBy(b, (x) => x.id), 'Button ids must be unique'),
});

export const ListBody = z.object({
  ...base,
  type: z.literal('list'),
  body: text(L.bodyMax),
  header: optText(L.headerTextMax),
  footer: optText(L.footerMax),
  button: text(L.listButtonMax),
  sections: z
    .array(
      z.object({
        title: optText(L.sectionTitleMax),
        rows: z
          .array(
            z.object({
              id: text(200),
              title: text(L.rowTitleMax),
              description: optText(L.rowDescriptionMax),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(L.listSectionsMax)
    .refine(
      (s) => s.flatMap((x) => x.rows).length <= L.listRowsMax,
      `At most ${String(L.listRowsMax)} rows in total`,
    )
    .refine(
      (s) =>
        uniqueBy(
          s.flatMap((x) => x.rows),
          (r) => r.id,
        ),
      'Row ids must be unique',
    ),
});

export const CtaUrlBody = z.object({
  ...base,
  type: z.literal('cta_url'),
  body: text(L.bodyMax),
  header: optText(L.headerTextMax),
  footer: optText(L.footerMax),
  displayText: text(L.ctaTextMax),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https:\/\/[^\s]+$/i, 'Must be an https:// link'),
});

export const ReactionBody = z.object({
  ...base,
  type: z.literal('reaction'),
  messageId: ObjectIdSchema,
  /** `''` removes our reaction. */
  emoji: z
    .string()
    .max(32)
    .refine((e) => [...e].length <= 8, 'One emoji'),
});

export const NoteBody = z.object({ ...base, type: z.literal('note'), text: text(L.textMax) });

export const SendMessageBody = z
  .discriminatedUnion('type', [
    TextBody,
    ImageBody,
    VideoBody,
    AudioBody,
    VoiceBody,
    DocumentBody,
    StickerBody,
    LocationBody,
    ContactsBody,
    ButtonsBody,
    ListBody,
    CtaUrlBody,
    ReactionBody,
    NoteBody,
  ])
  .openapi('InboxSendMessage');
export type SendMessageInput = z.infer<typeof SendMessageBody>;

export const SEND_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contacts',
  'buttons',
  'list',
  'cta_url',
  'reaction',
  'note',
] as const;
