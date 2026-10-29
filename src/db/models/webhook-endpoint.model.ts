import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const WEBHOOK_DISABLED_REASONS = ['failing', 'manual'] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

export interface WebhookEndpointDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** https in production; checked at save and again at every delivery (DNS re-resolved). */
  url: string;
  description: string;
  /** Event types, or `['*']` for all. */
  events: string[];
  /** Signing secret sealed with the secret box — shown once (`whsec_…`). */
  secretSealed: string;
  /** The previous secret during a rotation (still signs for 24 h). */
  secretPreviousSealed: string | null;
  rotatedAt: Date | null;
  /** Phone / name / summary / message text only when on (default off). */
  includePersonalData: boolean;
  active: boolean;
  disabledReason: WebhookDisabledReason | null;
  disabledAt: Date | null;
  /** Events given up in a row (5 → disabled). */
  failureStreak: number;
  /** First failure since the last success (24 h → disabled). */
  failingSince: Date | null;
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: 'succeeded' | 'failed' | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<WebhookEndpointDoc>({
  url: { type: String, required: true, maxlength: 2048 },
  description: { type: String, default: '', maxlength: 200 },
  events: { type: [String], default: ['*'] },
  secretSealed: { type: String, required: true, select: false },
  secretPreviousSealed: { type: String, default: null, select: false },
  rotatedAt: { type: Date, default: null },
  includePersonalData: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  disabledReason: { type: String, enum: [...WEBHOOK_DISABLED_REASONS, null], default: null },
  disabledAt: { type: Date, default: null },
  failureStreak: { type: Number, default: 0 },
  failingSince: { type: Date, default: null },
  lastDeliveryAt: { type: Date, default: null },
  lastDeliveryStatus: { type: String, enum: ['succeeded', 'failed', null], default: null },
  createdBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin, { hide: ['secretSealed', 'secretPreviousSealed'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ accountId: 1, active: 1 });
schema.index({ active: 1, failingSince: 1 });

/** Outbound webhook endpoints (Phase 15, data-model.md; ≤ 10 per account). */
export const WebhookEndpointModel: Model<WebhookEndpointDoc> =
  (mongoose.models.WebhookEndpoint as Model<WebhookEndpointDoc> | undefined) ??
  mongoose.model<WebhookEndpointDoc>('WebhookEndpoint', schema, 'webhookEndpoints');
