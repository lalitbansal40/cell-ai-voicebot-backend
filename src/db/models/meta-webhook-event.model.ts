import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export const META_EVENT_STATUSES = [
  'received',
  'processed',
  'deferred',
  'ignored',
  'failed',
] as const;
export type MetaEventStatus = (typeof META_EVENT_STATUSES)[number];

export interface MetaWebhookEventDoc {
  _id: Types.ObjectId;
  /** sha256(object | entry id | field | stable JSON of the value) — idempotency. */
  key: string;
  object: string;
  field: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  accountId: Types.ObjectId | null;
  channelId: Types.ObjectId | null;
  /** The change `value` (customer PII inside), sealed with the secret box. */
  payloadSealed?: string;
  status: MetaEventStatus;
  attempts: number;
  /** No PII — schema / routing / handler error text. */
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  /** Set when a later phase consumed a deferred event. */
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<MetaWebhookEventDoc>({
  key: { type: String, required: true, maxlength: 64 },
  object: { type: String, required: true, maxlength: 60 },
  field: { type: String, required: true, maxlength: 80 },
  wabaId: { type: String, default: null },
  phoneNumberId: { type: String, default: null },
  accountId: { type: Schema.Types.ObjectId, default: null },
  channelId: { type: Schema.Types.ObjectId, default: null },
  payloadSealed: { type: String, required: true, select: false },
  status: { type: String, enum: META_EVENT_STATUSES, default: 'received', required: true },
  attempts: { type: Number, default: 0 },
  error: { type: String, default: null, maxlength: 300 },
  receivedAt: { type: Date, required: true },
  processedAt: { type: Date, default: null },
  consumedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin, { hide: ['payloadSealed'] });
schema.index({ key: 1 }, { unique: true });
schema.index({ status: 1, receivedAt: 1 });
schema.index({ channelId: 1, field: 1, receivedAt: -1 });
schema.index({ field: 1, status: 1, receivedAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Meta webhook deliveries, one per change (PHASE_9_PLAN §1e). System collection. */
export const MetaWebhookEventModel: Model<MetaWebhookEventDoc> =
  (mongoose.models.MetaWebhookEvent as Model<MetaWebhookEventDoc> | undefined) ??
  mongoose.model<MetaWebhookEventDoc>('MetaWebhookEvent', schema, 'metaWebhookEvents');
