import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { INBOX_LIMITS, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * `business_app` = coexistence echo (sent from the phone); `system` = Meta / our system message;
 * `api` = sent through the internal API (Phase 11; public API in Phase 15).
 */
export const MESSAGE_ORIGINS = [
  'customer',
  'agent',
  'business_app',
  'history',
  'system',
  'api',
] as const;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

/** `note` = internal team note, never sent to WhatsApp. */
export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'order',
  'system',
  'unsupported',
  'note',
  'template',
  'call',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Inbound: `received` / `deleted`; outbound: `queued` → `accepted` → `sent` → `delivered` → `read` | `failed`. */
export const MESSAGE_STATUSES = [
  'received',
  'queued',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'deleted',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MEDIA_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const INTERACTIVE_KINDS = [
  'button',
  'list',
  'cta_url',
  'button_reply',
  'list_reply',
  'nfm_reply',
  // WhatsApp calling (Phase 12)
  'call_permission_request',
  'call_permission_reply',
  'voice_call',
] as const;
export type InteractiveKind = (typeof INTERACTIVE_KINDS)[number];

export const INTERACTIVE_HEADER_TYPES = ['text', 'image', 'video', 'document'] as const;
export type InteractiveHeaderType = (typeof INTERACTIVE_HEADER_TYPES)[number];

export const REACTION_ACTORS = ['customer', 'agent'] as const;
export type ReactionActor = (typeof REACTION_ACTORS)[number];

export interface MessageMedia {
  metaMediaId: string | null;
  metaMediaUploadedAt: Date | null;
  storageKey: string | null;
  mimeType: string | null;
  size: number | null;
  sha256: string | null;
  fileName: string | null;
  /** Voice note (inbound: Meta's `voice` flag; outbound: recorded in the browser). */
  voice: boolean;
  durationSec: number | null;
  animated: boolean;
  status: MediaStatus;
  error: string | null;
}

export interface MessageLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
  url: string | null;
}

export interface MessageContactCard {
  name: string;
  phones: { phone: string; type: string | null; waId: string | null }[];
  emails: { email: string; type: string | null }[];
  org: string | null;
}

export interface InteractiveHeader {
  type: InteractiveHeaderType;
  text: string | null;
  /** Media header (outgoing) — the stored file. */
  storageKey: string | null;
  metaMediaId: string | null;
  mimeType: string | null;
  fileName: string | null;
}

export interface InteractiveButton {
  id: string;
  title: string;
}

export interface InteractiveRow {
  id: string;
  title: string;
  description: string | null;
}

export interface InteractiveSection {
  title: string | null;
  rows: InteractiveRow[];
}

export interface MessageInteractive {
  kind: InteractiveKind;
  header: InteractiveHeader | null;
  body: string | null;
  footer: string | null;
  buttons: InteractiveButton[];
  /** List button label. */
  listButton: string | null;
  sections: InteractiveSection[];
  cta: { displayText: string; url: string } | null;
  /** Customer's reply (button / list) or form submission (nfm). */
  reply: { id: string | null; title: string | null; description: string | null } | null;
  /** WhatsApp Flows `response_json` (≤ `INBOX_LIMITS.nfmResponseMaxBytes`). */
  nfmResponse: string | null;
  nfmTruncated: boolean;
  /** `call_permission_reply` (Phase 12): the customer's answer. */
  callPermission?: InteractiveCallPermission | null;
  /** `voice_call` (Phase 12): the call button we sent. */
  voiceCall?: { displayText: string; ttlMinutes: number | null; payload: string | null } | null;
}

export const CALL_PERMISSION_RESPONSES = ['accept', 'reject'] as const;

export interface InteractiveCallPermission {
  response: (typeof CALL_PERMISSION_RESPONSES)[number];
  isPermanent: boolean;
  expiresAt: Date | null;
  /** Meta's `response_source` (`user_action` / `automatic`). */
  source: string | null;
  /** The request message this answers (`context.id`). */
  requestWaMessageId: string | null;
}

export const CALL_MESSAGE_OUTCOMES = [
  'missed',
  'completed',
  'rejected',
  'failed',
  'no_answer',
] as const;
export type CallMessageOutcome = (typeof CALL_MESSAGE_OUTCOMES)[number];

/** `type: 'call'` bubble (Phase 12) — one per WhatsApp call in the chat. */
export interface MessageCall {
  callId: Types.ObjectId;
  direction: 'in' | 'out';
  outcome: CallMessageOutcome;
  durationSec: number;
  mode: 'ai' | 'human';
}

export interface MessageReactionInfo {
  targetWaMessageId: string | null;
  targetMessageId: Types.ObjectId | null;
  /** Empty = reaction removed. */
  emoji: string;
}

export interface MessageReaction {
  emoji: string;
  by: ReactionActor;
  userId: Types.ObjectId | null;
  at: Date;
}

export interface MessageReferral {
  sourceUrl: string | null;
  sourceType: string | null;
  sourceId: string | null;
  headline: string | null;
  body: string | null;
  ctwaClid: string | null;
}

export interface MessageContext {
  replyToWaMessageId: string | null;
  replyToMessageId: Types.ObjectId | null;
  forwarded: boolean;
  frequentlyForwarded: boolean;
  referral: MessageReferral | null;
}

export interface MessageStatusEntry {
  status: MessageStatus;
  at: Date;
}

export interface MessageError {
  code: number | null;
  title: string | null;
  /** Shown on the bubble (our text, no customer data). */
  reason: string;
}

export interface MessagePricing {
  billable: boolean | null;
  model: string | null;
  category: string | null;
  type: string | null;
  /** Meta's `subtype` (e.g. `paid_exempt`, from 12 Oct 2026). */
  subtype: string | null;
  conversationId: string | null;
  conversationOrigin: string | null;
}

/** A sent template (Phase 11) — `parameters` are customer data (never logged). */
export interface MessageTemplateRef {
  templateId: Types.ObjectId;
  name: string;
  language: string;
  category: string;
  parameters: { key: string; value: string }[];
}

export const MESSAGE_BILLING_STATUSES = [
  'none',
  'held',
  'captured',
  'released',
  'late_charged',
  'waived',
] as const;
export type MessageBillingStatus = (typeof MESSAGE_BILLING_STATUSES)[number];

export const MESSAGE_PAYERS = ['platform', 'customer'] as const;
export type MessagePayer = (typeof MESSAGE_PAYERS)[number];

/** What this message costs the account (Phase 11) — the price is fixed at send. */
export interface MessageBilling {
  payer: MessagePayer;
  market: string;
  /** `marketing` / `utility` / `authentication` / `service`. */
  category: string;
  estimateMicros: number;
  priceMicros: number;
  metaCostMicros: number;
  holdId: Types.ObjectId | null;
  status: MessageBillingStatus;
  billable: boolean | null;
  pricingType: string | null;
  /** The category Meta billed, when it differs from ours. */
  metaCategory: string | null;
  categoryMismatch: boolean;
  at: Date | null;
}

export interface MessageOrder {
  catalogId: string | null;
  itemsCount: number;
  total: number | null;
  currency: string | null;
}

export interface MessageButton {
  payload: string | null;
  text: string | null;
}

export interface MessageSystem {
  kind: string;
  newWaIdLast4: string | null;
}

export interface MessageDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  conversationId: Types.ObjectId;
  channelId: Types.ObjectId;
  contactId: Types.ObjectId;
  direction: MessageDirection;
  origin: MessageOrigin;
  type: MessageType;
  /** Body / caption (customer data — never logged). */
  text: string | null;
  media: MessageMedia | null;
  location: MessageLocation | null;
  contacts: MessageContactCard[] | null;
  interactive: MessageInteractive | null;
  reaction: MessageReactionInfo | null;
  context: MessageContext | null;
  /** Reactions on this message (denormalised for the bubble). */
  reactions: MessageReaction[];
  order: MessageOrder | null;
  button: MessageButton | null;
  system: MessageSystem | null;
  /** `type: 'call'` (Phase 12). */
  call?: MessageCall | null;
  status: MessageStatus;
  statusHistory: MessageStatusEntry[];
  error: MessageError | null;
  waMessageId: string | null;
  /** Outgoing idempotency key (uuid from the browser). */
  clientId: string | null;
  sentBy: Types.ObjectId | null;
  retryOf: Types.ObjectId | null;
  pricing: MessagePricing | null;
  template: MessageTemplateRef | null;
  billing: MessageBilling | null;
  metaTimestamp: Date | null;
  /** Chat order, paging and retention: Meta's time for inbound / echoes / history, send time otherwise. */
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

const nullableString = { type: String, default: null };
const sub = <T>(definition: Record<string, unknown>) => new Schema<T>(definition, { _id: false });

const mediaSchema = sub<MessageMedia>({
  metaMediaId: nullableString,
  metaMediaUploadedAt: { type: Date, default: null },
  storageKey: nullableString,
  mimeType: { type: String, default: null, maxlength: 120 },
  size: { type: Number, default: null, min: 0 },
  sha256: nullableString,
  fileName: { type: String, default: null, maxlength: INBOX_LIMITS.fileNameMax },
  voice: { type: Boolean, default: false },
  durationSec: { type: Number, default: null, min: 0 },
  animated: { type: Boolean, default: false },
  status: { type: String, enum: MEDIA_STATUSES, default: 'pending' },
  error: { type: String, default: null, maxlength: 300 },
});

const locationSchema = sub<MessageLocation>({
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  name: { type: String, default: null, maxlength: 1000 },
  address: { type: String, default: null, maxlength: 1000 },
  url: { type: String, default: null, maxlength: 2000 },
});

const contactCardSchema = sub<MessageContactCard>({
  name: { type: String, required: true, maxlength: 256 },
  phones: {
    type: [
      sub({
        phone: { type: String, required: true, maxlength: 40 },
        type: { type: String, default: null, maxlength: 40 },
        waId: { type: String, default: null, maxlength: 20 },
      }),
    ],
    default: [],
  },
  emails: {
    type: [
      sub({
        email: { type: String, required: true, maxlength: 254 },
        type: { type: String, default: null, maxlength: 40 },
      }),
    ],
    default: [],
  },
  org: { type: String, default: null, maxlength: 256 },
});

const interactiveSchema = sub<MessageInteractive>({
  kind: { type: String, enum: INTERACTIVE_KINDS, required: true },
  header: {
    type: sub<InteractiveHeader>({
      type: { type: String, enum: INTERACTIVE_HEADER_TYPES, required: true },
      text: { type: String, default: null, maxlength: INBOX_LIMITS.headerTextMax },
      storageKey: nullableString,
      metaMediaId: nullableString,
      mimeType: nullableString,
      fileName: { type: String, default: null, maxlength: INBOX_LIMITS.fileNameMax },
    }),
    default: null,
  },
  body: { type: String, default: null, maxlength: INBOX_LIMITS.textMax },
  footer: { type: String, default: null, maxlength: INBOX_LIMITS.footerMax },
  buttons: {
    type: [
      sub<InteractiveButton>({
        id: { type: String, required: true, maxlength: INBOX_LIMITS.buttonIdMax },
        title: { type: String, required: true, maxlength: INBOX_LIMITS.buttonTitleMax },
      }),
    ],
    default: [],
  },
  listButton: { type: String, default: null, maxlength: INBOX_LIMITS.listButtonMax },
  sections: {
    type: [
      sub<InteractiveSection>({
        title: { type: String, default: null, maxlength: INBOX_LIMITS.sectionTitleMax },
        rows: {
          type: [
            sub<InteractiveRow>({
              id: { type: String, required: true, maxlength: 200 },
              title: { type: String, required: true, maxlength: INBOX_LIMITS.rowTitleMax },
              description: {
                type: String,
                default: null,
                maxlength: INBOX_LIMITS.rowDescriptionMax,
              },
            }),
          ],
          default: [],
        },
      }),
    ],
    default: [],
  },
  cta: {
    type: sub({
      displayText: { type: String, required: true, maxlength: INBOX_LIMITS.ctaTextMax },
      url: { type: String, required: true, maxlength: 2000 },
    }),
    default: null,
  },
  reply: {
    type: sub({
      id: { type: String, default: null, maxlength: 256 },
      title: { type: String, default: null, maxlength: 256 },
      description: { type: String, default: null, maxlength: 256 },
    }),
    default: null,
  },
  nfmResponse: { type: String, default: null, maxlength: INBOX_LIMITS.nfmResponseMaxBytes },
  nfmTruncated: { type: Boolean, default: false },
  callPermission: {
    type: sub<InteractiveCallPermission>({
      response: { type: String, enum: CALL_PERMISSION_RESPONSES, required: true },
      isPermanent: { type: Boolean, default: false },
      expiresAt: { type: Date, default: null },
      source: { type: String, default: null, maxlength: 40 },
      requestWaMessageId: { type: String, default: null, maxlength: 256 },
    }),
    default: null,
  },
  voiceCall: {
    type: sub({
      displayText: {
        type: String,
        required: true,
        maxlength: WHATSAPP_CALL_LIMITS.voiceCallButtonTextMax,
      },
      ttlMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: WHATSAPP_CALL_LIMITS.voiceCallTtlMinutesMax,
      },
      payload: { type: String, default: null, maxlength: 512 },
    }),
    default: null,
  },
});

const reactionInfoSchema = sub<MessageReactionInfo>({
  targetWaMessageId: nullableString,
  targetMessageId: { type: Schema.Types.ObjectId, default: null },
  emoji: { type: String, default: '', maxlength: 32 },
});

const reactionSchema = sub<MessageReaction>({
  emoji: { type: String, required: true, maxlength: 32 },
  by: { type: String, enum: REACTION_ACTORS, required: true },
  userId: { type: Schema.Types.ObjectId, default: null },
  at: { type: Date, required: true },
});

const contextSchema = sub<MessageContext>({
  replyToWaMessageId: nullableString,
  replyToMessageId: { type: Schema.Types.ObjectId, default: null },
  forwarded: { type: Boolean, default: false },
  frequentlyForwarded: { type: Boolean, default: false },
  referral: {
    type: sub<MessageReferral>({
      sourceUrl: { type: String, default: null, maxlength: 2000 },
      sourceType: { type: String, default: null, maxlength: 40 },
      sourceId: { type: String, default: null, maxlength: 100 },
      headline: { type: String, default: null, maxlength: 1000 },
      body: { type: String, default: null, maxlength: 2000 },
      ctwaClid: { type: String, default: null, maxlength: 500 },
    }),
    default: null,
  },
});

const schema = new Schema<MessageDoc>({
  conversationId: { type: Schema.Types.ObjectId, required: true },
  channelId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
  origin: { type: String, enum: MESSAGE_ORIGINS, required: true },
  type: { type: String, enum: MESSAGE_TYPES, required: true },
  text: { type: String, default: null, maxlength: INBOX_LIMITS.textMax },
  media: { type: mediaSchema, default: null },
  location: { type: locationSchema, default: null },
  contacts: { type: [contactCardSchema], default: null },
  interactive: { type: interactiveSchema, default: null },
  reaction: { type: reactionInfoSchema, default: null },
  context: { type: contextSchema, default: null },
  reactions: { type: [reactionSchema], default: [] },
  order: {
    type: sub<MessageOrder>({
      catalogId: nullableString,
      itemsCount: { type: Number, default: 0, min: 0 },
      total: { type: Number, default: null },
      currency: { type: String, default: null, maxlength: 3 },
    }),
    default: null,
  },
  button: {
    type: sub<MessageButton>({
      payload: { type: String, default: null, maxlength: 1000 },
      text: { type: String, default: null, maxlength: 256 },
    }),
    default: null,
  },
  system: {
    type: sub<MessageSystem>({
      kind: { type: String, required: true, maxlength: 60 },
      newWaIdLast4: { type: String, default: null, maxlength: 4 },
    }),
    default: null,
  },
  status: { type: String, enum: MESSAGE_STATUSES, required: true },
  statusHistory: {
    type: [
      sub<MessageStatusEntry>({
        status: { type: String, enum: MESSAGE_STATUSES, required: true },
        at: { type: Date, required: true },
      }),
    ],
    default: [],
  },
  error: {
    type: sub<MessageError>({
      code: { type: Number, default: null },
      title: { type: String, default: null, maxlength: 300 },
      reason: { type: String, required: true, maxlength: 300 },
    }),
    default: null,
  },
  waMessageId: { type: String, default: null, maxlength: 200 },
  clientId: { type: String, default: null, maxlength: 64 },
  sentBy: { type: Schema.Types.ObjectId, default: null },
  retryOf: { type: Schema.Types.ObjectId, default: null },
  pricing: {
    type: sub<MessagePricing>({
      billable: { type: Boolean, default: null },
      model: nullableString,
      category: nullableString,
      type: nullableString,
      subtype: nullableString,
      conversationId: nullableString,
      conversationOrigin: nullableString,
    }),
    default: null,
  },
  template: {
    type: sub<MessageTemplateRef>({
      templateId: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true, maxlength: 512 },
      language: { type: String, required: true, maxlength: 20 },
      category: { type: String, required: true, maxlength: 20 },
      parameters: {
        type: [
          sub({
            key: { type: String, required: true, maxlength: 60 },
            value: { type: String, required: true, maxlength: 1024 },
          }),
        ],
        default: [],
      },
    }),
    default: null,
  },
  billing: {
    type: sub<MessageBilling>({
      payer: { type: String, enum: MESSAGE_PAYERS, required: true },
      market: { type: String, required: true, maxlength: 40 },
      category: { type: String, required: true, maxlength: 30 },
      estimateMicros: { type: Number, required: true, min: 0 },
      priceMicros: { type: Number, required: true, min: 0 },
      metaCostMicros: { type: Number, default: 0, min: 0 },
      holdId: { type: Schema.Types.ObjectId, default: null },
      status: { type: String, enum: MESSAGE_BILLING_STATUSES, default: 'none' },
      billable: { type: Boolean, default: null },
      pricingType: { type: String, default: null, maxlength: 40 },
      metaCategory: { type: String, default: null, maxlength: 40 },
      categoryMismatch: { type: Boolean, default: false },
      at: { type: Date, default: null },
    }),
    default: null,
  },
  call: {
    type: sub<MessageCall>({
      callId: { type: Schema.Types.ObjectId, required: true },
      direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
      outcome: { type: String, enum: CALL_MESSAGE_OUTCOMES, required: true },
      durationSec: { type: Number, default: 0, min: 0 },
      mode: { type: String, enum: ['ai', 'human'], required: true },
    }),
    default: null,
  },
  metaTimestamp: { type: Date, default: null },
  at: { type: Date, required: true },
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin);
// Meta redelivers webhooks: one row per wamid per number
schema.index(
  { accountId: 1, channelId: 1, waMessageId: 1 },
  { unique: true, partialFilterExpression: { waMessageId: { $type: 'string' } } },
);
schema.index({ accountId: 1, conversationId: 1, at: -1, _id: -1 });
// retention purge
schema.index({ at: 1 });
// Phase 14 analytics sweep (changed rows by `updatedAt`)
schema.index({ updatedAt: 1, _id: 1 }, { name: 'analytics_sweep' });
// Phase 14 recount (an account's messages by time)
schema.index({ accountId: 1, at: 1, _id: 1 }, { name: 'analytics_rebuild' });
schema.index(
  { accountId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
schema.index({ 'media.status': 1, createdAt: 1 });
// Phase 11: WhatsApp hold reaper (held charges by age)
schema.index(
  { 'billing.at': 1 },
  { partialFilterExpression: { 'billing.status': 'held' }, name: 'billing_held_at' },
);
// Phase 11: 1 marketing template / contact / 24 h + template usage
schema.index(
  { accountId: 1, contactId: 1, 'template.category': 1, at: -1 },
  { partialFilterExpression: { type: 'template' }, name: 'template_contact_at' },
);
// Phase 12: one call bubble per call
schema.index(
  { accountId: 1, 'call.callId': 1 },
  { unique: true, partialFilterExpression: { type: 'call' }, name: 'call_bubble' },
);
// search; no stemming so Hinglish words match as typed
schema.index({ accountId: 1, text: 'text' }, { default_language: 'none' });

/** One WhatsApp message or internal note (data-model.md §2.8). PII: text, media, location, contacts. */
export const MessageModel: Model<MessageDoc> =
  (mongoose.models.Message as Model<MessageDoc> | undefined) ??
  mongoose.model<MessageDoc>('Message', schema, 'messages');
