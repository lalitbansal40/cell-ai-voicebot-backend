import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WEBHOOK_LIMITS } from '../../config/limits';

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'gave_up'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface WebhookAttempt {
  attempt: number;
  at: Date;
  ok: boolean;
  responseStatus: number | null;
  responseMs: number;
  /** `timeout`, `network`, `blocked`, `redirect`, `http_<status>` — never bodies. */
  error: string | null;
}

export interface WebhookDeliveryDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  endpointId: Types.ObjectId;
  eventId: string;
  type: string;
  /** A "Send test event" delivery (sample payload, not retried). */
  test: boolean;
  /** `pending` = next attempt scheduled; `failed` = the last attempt failed (manual replay). */
  status: WebhookDeliveryStatus;
  /** Attempts made so far (replays add to it). */
  attempt: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  responseStatus: number | null;
  responseMs: number | null;
  /** First 1 KB of the receiver's answer, text only (never rendered as HTML). */
  responseSnippet: string | null;
  error: string | null;
  attempts: WebhookAttempt[];
  createdAt: Date;
  updatedAt: Date;
}

const attemptSchema = new Schema<WebhookAttempt>(
  {
    attempt: Number,
    at: Date,
    ok: Boolean,
    responseStatus: { type: Number, default: null },
    responseMs: Number,
    error: { type: String, default: null },
  },
  { _id: false },
);

const schema = new Schema<WebhookDeliveryDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    endpointId: { type: Schema.Types.ObjectId, required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    test: { type: Boolean, default: false },
    status: { type: String, enum: WEBHOOK_DELIVERY_STATUSES, default: 'pending' },
    attempt: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    responseStatus: { type: Number, default: null },
    responseMs: { type: Number, default: null },
    responseSnippet: {
      type: String,
      default: null,
      maxlength: WEBHOOK_LIMITS.responseSnippetBytes,
    },
    error: { type: String, default: null },
    attempts: { type: [attemptSchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);
schema.index(
  { endpointId: 1, eventId: 1 },
  { unique: true, partialFilterExpression: { test: false } },
);
schema.index({ accountId: 1, endpointId: 1, createdAt: -1, _id: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: WEBHOOK_LIMITS.eventTtlDays * 86_400 });

/** One row per event × endpoint (Phase 15), TTL 30 days. */
export const WebhookDeliveryModel: Model<WebhookDeliveryDoc> =
  (mongoose.models.WebhookDelivery as Model<WebhookDeliveryDoc> | undefined) ??
  mongoose.model<WebhookDeliveryDoc>('WebhookDelivery', schema, 'webhookDeliveries');
