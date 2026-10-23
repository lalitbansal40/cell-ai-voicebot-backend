import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';

export const PLATFORM_SETTING_KEYS = ['whatsappBilling'] as const;
export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

/** Global WhatsApp price settings (superadmin). Accounts may override them. */
export interface WhatsAppBillingSettings {
  /** Our markup on Meta's rate, basis points (1500 = 15 %). */
  markupBps: number;
  /** Added to every message (micros); also the only charge for customer-pays accounts. */
  platformFeeMicros: number;
  /** Holds without a decisive status are released after this many hours. */
  holdMaxAgeHours: number;
}

export const DEFAULT_WHATSAPP_BILLING_SETTINGS: WhatsAppBillingSettings = {
  markupBps: WHATSAPP_BILLING_LIMITS.defaultMarkupBps,
  platformFeeMicros: 0,
  holdMaxAgeHours: WHATSAPP_BILLING_LIMITS.holdMaxAgeMs / 3_600_000,
};

export interface PlatformSettingsValues {
  whatsappBilling: WhatsAppBillingSettings;
}

export interface PlatformSettingsDoc<K extends PlatformSettingKey = PlatformSettingKey> {
  _id: Types.ObjectId;
  key: K;
  value: PlatformSettingsValues[K];
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappBilling = new Schema<WhatsAppBillingSettings>(
  {
    markupBps: { type: Number, required: true, min: 0, max: 100_000 },
    platformFeeMicros: { type: Number, required: true, min: 0 },
    holdMaxAgeHours: { type: Number, required: true, min: 1, max: 24 * 30 },
  },
  { _id: false },
);

const schema = new Schema<PlatformSettingsDoc>({
  key: { type: String, enum: PLATFORM_SETTING_KEYS, required: true },
  // one value shape per key; only `whatsappBilling` exists today
  value: { type: whatsappBilling, required: true },
  updatedBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin);
schema.index({ key: 1 }, { unique: true });

/** Platform-wide settings, one row per key, no `accountId` (data-model.md §2.9). Reads fall back to code defaults. */
export const PlatformSettingsModel: Model<PlatformSettingsDoc> =
  (mongoose.models.PlatformSettings as Model<PlatformSettingsDoc> | undefined) ??
  mongoose.model<PlatformSettingsDoc>('PlatformSettings', schema, 'platformSettings');
