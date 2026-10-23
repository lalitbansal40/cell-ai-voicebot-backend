import { INBOX_LIMITS as L } from '../../config/limits';
import { BUSINESS_VERTICALS } from '../../core/meta';
import { INBOX_NOTIFY_MODES } from '../../db/models/account.model';
import { UPLOAD_KINDS } from '../../db/models/inbox-upload.model';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { TemplateBody } from './outbound.schema';

export const ConversationParams = z.object({ id: ObjectIdSchema });
export const MessageParams = z.object({ id: ObjectIdSchema });

export const ListConversationsQuery = z.object({
  status: z.enum(['open', 'closed']).default('open'),
  filter: z.enum(['all', 'unread', 'mine', 'unassigned']).default('all'),
  channelId: ObjectIdSchema.optional(),
  q: z.string().trim().min(2).max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(L.conversationsPageMax).default(30),
});

export const ListMessagesQuery = z
  .object({
    before: z.string().max(200).optional(),
    around: ObjectIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(L.messagesPageMax).default(50),
  })
  .refine((q) => !(q.before && q.around), {
    message: 'Use before or around, not both',
    path: ['around'],
  });

export const AssignBody = z.object({
  assignedTo: ObjectIdSchema.nullable().openapi({ description: 'User id, or null to unassign' }),
});

export const StartConversationBody = z.object({
  channelId: ObjectIdSchema,
  contactId: ObjectIdSchema,
  /** Phase 11: send a template right away (contact page); `clientId` generated when omitted. */
  template: TemplateBody.extend({ clientId: TemplateBody.shape.clientId.optional() }).optional(),
});

/** Multipart fields of `POST /inbox/media` (the file is the `file` part). */
export const UploadFields = z.object({
  kind: z.enum(UPLOAD_KINDS),
  durationSec: z.coerce
    .number()
    .min(0)
    .max(L.voiceNoteMaxSeconds * 2)
    .optional(),
});

const keyword = z.string().trim().min(1).max(L.keywordMaxLength);
export const InboxSettingsPatchBody = z
  .object({
    sendReadReceipts: z.boolean(),
    optOutKeywords: z.array(keyword).min(1).max(L.optOutKeywordsMax),
    optInKeywords: z.array(keyword).max(L.optOutKeywordsMax),
    optOutReply: z.boolean(),
    optOutReplyText: z.string().trim().min(1).max(L.replyTextMax),
    optInReply: z.boolean(),
    optInReplyText: z.string().trim().min(1).max(L.replyTextMax),
    notifyOnNewMessage: z.enum(INBOX_NOTIFY_MODES),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

const website = z
  .string()
  .trim()
  .max(256)
  .regex(/^https?:\/\/[^\s]+$/i, 'Must be an http(s) link');
export const BusinessProfilePatchBody = z
  .object({
    about: z.string().trim().min(1).max(139),
    address: z.string().trim().max(256),
    description: z.string().trim().max(512),
    email: z.email().max(128).or(z.literal('')),
    websites: z.array(website).max(2),
    vertical: z.enum(BUSINESS_VERTICALS),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
