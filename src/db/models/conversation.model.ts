import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { MESSAGE_DIRECTIONS, MESSAGE_STATUSES, MESSAGE_TYPES } from './message.model';
import type { MessageDirection, MessageStatus, MessageType } from './message.model';

export const CONVERSATION_STATUSES = ['open', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** How the conversation started. */
export const CONVERSATION_SOURCES = ['inbound', 'outbound', 'business_app', 'history'] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

/** Denormalised last message for the conversation list. */
export interface ConversationLastMessage {
  id: Types.ObjectId;
  direction: MessageDirection;
  type: MessageType;
  /** Text / caption / type label, ≤ `INBOX_LIMITS.previewMax` (customer data — never logged). */
  preview: string;
  at: Date;
  status: MessageStatus;
}

export interface ConversationDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  contactId: Types.ObjectId;
  /** Customer's WhatsApp id (digits, from Meta). */
  waId: string;
  phoneE164: string;
  profileName: string | null;
  status: ConversationStatus;
  assignedTo: Types.ObjectId | null;
  unreadCount: number;
  lastMessage: ConversationLastMessage | null;
  /** Window start: the customer's last message. */
  lastInboundAt: Date | null;
  windowExpiresAt: Date | null;
  lastReadAt: Date | null;
  lastReadBy: Types.ObjectId | null;
  /** Blocked on WhatsApp (Block Users API). */
  blocked: boolean;
  source: ConversationSource;
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lastMessageSchema = new Schema<ConversationLastMessage>(
  {
    id: { type: Schema.Types.ObjectId, required: true },
    direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
    type: { type: String, enum: MESSAGE_TYPES, required: true },
    preview: { type: String, default: '', maxlength: INBOX_LIMITS.previewMax },
    at: { type: Date, required: true },
    status: { type: String, enum: MESSAGE_STATUSES, required: true },
  },
  { _id: false },
);

const schema = new Schema<ConversationDoc>({
  channelId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  waId: { type: String, required: true, match: /^\d{6,20}$/ },
  phoneE164: { type: String, required: true },
  profileName: { type: String, default: null, maxlength: 256 },
  status: { type: String, enum: CONVERSATION_STATUSES, default: 'open' },
  assignedTo: { type: Schema.Types.ObjectId, default: null },
  unreadCount: { type: Number, default: 0, min: 0 },
  lastMessage: { type: lastMessageSchema, default: null },
  lastInboundAt: { type: Date, default: null },
  windowExpiresAt: { type: Date, default: null },
  lastReadAt: { type: Date, default: null },
  lastReadBy: { type: Schema.Types.ObjectId, default: null },
  blocked: { type: Boolean, default: false },
  source: { type: String, enum: CONVERSATION_SOURCES, required: true },
  closedAt: { type: Date, default: null },
  closedBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin);
// one conversation per number × customer
schema.index({ accountId: 1, channelId: 1, waId: 1 }, { unique: true });
schema.index({ accountId: 1, status: 1, 'lastMessage.at': -1, _id: -1 });
schema.index({ accountId: 1, assignedTo: 1, status: 1, 'lastMessage.at': -1 });
schema.index(
  { accountId: 1, unreadCount: 1 },
  { partialFilterExpression: { unreadCount: { $gt: 0 } } },
);
schema.index({ accountId: 1, contactId: 1 });

/** A WhatsApp chat between one connected number and one customer (data-model.md §2.8). PII: phone, profile name, preview. */
export const ConversationModel: Model<ConversationDoc> =
  (mongoose.models.Conversation as Model<ConversationDoc> | undefined) ??
  mongoose.model<ConversationDoc>('Conversation', schema, 'conversations');
