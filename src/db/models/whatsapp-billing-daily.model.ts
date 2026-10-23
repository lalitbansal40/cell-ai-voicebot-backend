import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

/** Meta pricing categories as reported by `pricing_analytics` (lower case). */
export const BILLING_DAILY_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'authentication_international',
  'service',
  'marketing_lite',
] as const;
export type BillingDailyCategory = (typeof BILLING_DAILY_CATEGORIES)[number];

/** Reconciliation of one WABA day + category: Meta's numbers vs our captured charges. */
export interface WhatsAppBillingDailyDoc {
  _id: Types.ObjectId;
  /** Owner of the WABA (platform reporting row — not tenant-scoped). */
  accountId: Types.ObjectId;
  wabaId: string;
  /** `YYYY-MM-DD` (UTC, Meta's day). */
  day: string;
  category: BillingDailyCategory;
  metaVolume: number;
  metaCostMicros: number;
  ourCaptured: number;
  ourBilledMicros: number;
  diffVolume: number;
  diffMicros: number;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const count = { type: Number, required: true, min: 0 };

const schema = new Schema<WhatsAppBillingDailyDoc>({
  accountId: { type: Schema.Types.ObjectId, required: true },
  wabaId: { type: String, required: true, maxlength: 64 },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  category: { type: String, enum: BILLING_DAILY_CATEGORIES, required: true },
  metaVolume: count,
  metaCostMicros: count,
  ourCaptured: count,
  ourBilledMicros: count,
  diffVolume: { type: Number, required: true },
  diffMicros: { type: Number, required: true },
  fetchedAt: { type: Date, required: true },
});
schema.plugin(basePlugin);
schema.index({ wabaId: 1, day: 1, category: 1 }, { unique: true });
schema.index({ day: -1 });
schema.index({ accountId: 1, day: -1 });

/** Daily Meta-vs-us WhatsApp billing rows (superadmin reconciliation; data-model.md §2.9). */
export const WhatsAppBillingDailyModel: Model<WhatsAppBillingDailyDoc> =
  (mongoose.models.WhatsAppBillingDaily as Model<WhatsAppBillingDailyDoc> | undefined) ??
  mongoose.model<WhatsAppBillingDailyDoc>('WhatsAppBillingDaily', schema, 'whatsappBillingDaily');
