import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const NOTIFICATION_TYPES = [
  'wallet.low_balance',
  'wallet.exhausted',
  'wallet.topup_paid',
  'wallet.adjusted',
  'billing.refund_received',
  'billing.payment_unmatched',
  'billing.payment_mismatch',
  'billing.reconcile_mismatch',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Kept 90 days (data-model.md §Notification). */
export const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface NotificationDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** One row per recipient (fan-out at creation → each user has their own read state). */
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app route, e.g. `/wallet`. */
  link: string | null;
  readAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<NotificationDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  type: { type: String, enum: NOTIFICATION_TYPES, required: true },
  title: { type: String, required: true, maxlength: 120 },
  body: { type: String, required: true, maxlength: 500 },
  link: { type: String, default: null, maxlength: 200 },
  readAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin, { hide: ['expiresAt'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, userId: 1, readAt: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** In-app notifications (the header bell). */
export const NotificationModel: Model<NotificationDoc> =
  (mongoose.models.Notification as Model<NotificationDoc> | undefined) ??
  mongoose.model<NotificationDoc>('Notification', schema, 'notifications');
