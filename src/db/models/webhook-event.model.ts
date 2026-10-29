import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WEBHOOK_LIMITS } from '../../config/limits';

export interface WebhookEventDoc {
  /** `evt_<ulid>` — stable across retries and replays (receivers de-duplicate on it). */
  _id: string;
  accountId: Types.ObjectId;
  type: string;
  /** The full payload data; the personal-data filter runs per endpoint at delivery. */
  data: Record<string, unknown>;
  createdAt: Date;
}

const schema = new Schema<WebhookEventDoc>(
  {
    _id: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true, maxlength: 60 },
    data: { type: Schema.Types.Mixed, default: () => ({}) },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false },
);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: WEBHOOK_LIMITS.eventTtlDays * 86_400 });

/** The webhook outbox (Phase 15): one row per account event, TTL 30 days. */
export const WebhookEventModel: Model<WebhookEventDoc> =
  (mongoose.models.WebhookEvent as Model<WebhookEventDoc> | undefined) ??
  mongoose.model<WebhookEventDoc>('WebhookEvent', schema, 'webhookEvents');
