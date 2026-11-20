import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

/**
 * SAC-T8: an AI WhatsApp call to place later ("Schedule AI call" in the inbox, an AI
 * agent's callback, or the API). Due time in UTC + the account timezone it was picked in.
 * `dispatching` is a claim (exactly-once); `calling` = the call was placed (`callIds`).
 */
export const SCHEDULED_CALL_STATUSES = [
  'scheduled',
  'dispatching',
  'calling',
  'done',
  'skipped',
  'failed',
  'cancelled',
] as const;
export type ScheduledCallStatus = (typeof SCHEDULED_CALL_STATUSES)[number];

/** The open ones (counted for the limits; can be edited / cancelled). */
export const OPEN_SCHEDULED_STATUSES: readonly ScheduledCallStatus[] = [
  'scheduled',
  'dispatching',
  'calling',
];

export const SCHEDULED_SKIP_REASONS = [
  'no_permission',
  'dnd',
  'opted_out',
  'outside_window',
  'channel_down',
  'calling_disabled',
  'program_inactive',
  'wallet',
  'capacity',
  'contact_deleted',
  'not_allowed',
] as const;
export type ScheduledSkipReason = (typeof SCHEDULED_SKIP_REASONS)[number];

export const SCHEDULED_ORIGINS = ['manual', 'ai_callback', 'api'] as const;
export const SCHEDULED_RETRY_ON = ['no_answer', 'busy', 'failed'] as const;
export type ScheduledRetryOn = (typeof SCHEDULED_RETRY_ON)[number];

export interface ScheduledAttempt {
  at: Date;
  callId: Types.ObjectId | null;
  result: 'answered' | 'no_answer' | 'busy' | 'failed' | 'skipped';
  reason: string | null;
}

export interface WhatsAppScheduledCallDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  contactId: Types.ObjectId;
  conversationId: Types.ObjectId | null;
  program: { kind: 'flow' | 'agent'; id: Types.ObjectId };
  purpose: string | null;
  dueAt: Date;
  timezone: string;
  status: ScheduledCallStatus;
  skipReason: ScheduledSkipReason | null;
  origin: (typeof SCHEDULED_ORIGINS)[number];
  /** 0 = the first try; each retry adds one. */
  attempt: number;
  retry: { max: number; gapMin: number; on: ScheduledRetryOn[] };
  attempts: ScheduledAttempt[];
  /** Moved once to the next allowed time (calling window / call hours). */
  shiftedAt: Date | null;
  /** The process claim (stale after 10 minutes → back to `scheduled`). */
  claimedAt: Date | null;
  /** How often "line full" put it back (at most 3, then `failed`). */
  capacityRetries: number;
  callIds: Types.ObjectId[];
  createdBy: Types.ObjectId;
  impersonatorId: Types.ObjectId | null;
  cancelledBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<WhatsAppScheduledCallDoc>({
  channelId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true },
  conversationId: { type: Schema.Types.ObjectId, default: null },
  program: {
    type: new Schema(
      {
        kind: { type: String, enum: ['flow', 'agent'], required: true },
        id: { type: Schema.Types.ObjectId, required: true },
      },
      { _id: false },
    ),
    required: true,
  },
  purpose: { type: String, default: null, maxlength: 500 },
  dueAt: { type: Date, required: true },
  timezone: { type: String, required: true, maxlength: 64 },
  status: { type: String, enum: SCHEDULED_CALL_STATUSES, default: 'scheduled', required: true },
  skipReason: { type: String, enum: [...SCHEDULED_SKIP_REASONS, null], default: null },
  origin: { type: String, enum: SCHEDULED_ORIGINS, default: 'manual' },
  attempt: { type: Number, default: 0, min: 0 },
  retry: {
    type: new Schema(
      {
        max: { type: Number, default: 0, min: 0, max: 2 },
        gapMin: { type: Number, default: 30, min: 15, max: 240 },
        on: { type: [String], enum: SCHEDULED_RETRY_ON, default: [] },
      },
      { _id: false },
    ),
    default: () => ({ max: 0, gapMin: 30, on: [] }),
  },
  attempts: {
    type: [
      new Schema(
        {
          at: { type: Date, required: true },
          callId: { type: Schema.Types.ObjectId, default: null },
          result: {
            type: String,
            enum: ['answered', 'no_answer', 'busy', 'failed', 'skipped'],
            required: true,
          },
          reason: { type: String, default: null, maxlength: 64 },
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  shiftedAt: { type: Date, default: null },
  claimedAt: { type: Date, default: null },
  capacityRetries: { type: Number, default: 0 },
  callIds: { type: [Schema.Types.ObjectId], default: [] },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  impersonatorId: { type: Schema.Types.ObjectId, default: null },
  cancelledBy: { type: Schema.Types.ObjectId, default: null },
  cancelledAt: { type: Date, default: null },
  idempotencyKey: { type: String, default: null, maxlength: 100 },
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin);
// the dispatcher: due rows across accounts
schema.index({ status: 1, dueAt: 1 });
schema.index({ accountId: 1, contactId: 1, status: 1, dueAt: 1 });
schema.index({ accountId: 1, status: 1, dueAt: -1 });
schema.index(
  { accountId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const WhatsAppScheduledCallModel: Model<WhatsAppScheduledCallDoc> =
  (mongoose.models.WhatsAppScheduledCall as Model<WhatsAppScheduledCallDoc> | undefined) ??
  mongoose.model<WhatsAppScheduledCallDoc>(
    'WhatsAppScheduledCall',
    schema,
    'whatsappScheduledCalls',
  );
