import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';

export const PLATFORM_SETTING_KEYS = ['whatsappBilling', 'whatsappCalling'] as const;
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

/** Global WhatsApp call price settings (superadmin, Phase 12). Accounts may override them. */
export interface WhatsAppCallingSettings {
  /** Our markup on Meta's per-minute rate, basis points (1500 = 15 %). */
  markupBps: number;
  /** Added per call minute (micros); the only call charge for customer-pays accounts. */
  platformFeePerMinuteMicros: number;
  /** First hold of a business-initiated call, minutes of the call price. */
  holdMinutes: number;
  /** Each hold extension, minutes. */
  holdExtendMinutes: number;
}

export const DEFAULT_WHATSAPP_CALLING_SETTINGS: WhatsAppCallingSettings = {
  markupBps: WHATSAPP_BILLING_LIMITS.defaultMarkupBps,
  platformFeePerMinuteMicros: 0,
  holdMinutes: WHATSAPP_CALL_LIMITS.holdMinutes,
  holdExtendMinutes: WHATSAPP_CALL_LIMITS.holdExtendMinutes,
};

export interface PlatformSettingsValues {
  whatsappBilling: WhatsAppBillingSettings;
  whatsappCalling: WhatsAppCallingSettings;
}

export interface PlatformSettingsDoc<K extends PlatformSettingKey = PlatformSettingKey> {
  _id: Types.ObjectId;
  key: K;
  value: PlatformSettingsValues[K];
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

type Range = readonly [min: number, max: number];

/** Allowed whole-number range of every field, per key. */
const VALUE_RANGES: { [K in PlatformSettingKey]: Record<keyof PlatformSettingsValues[K], Range> } =
  {
    whatsappBilling: {
      markupBps: [0, 100_000],
      platformFeeMicros: [0, Number.MAX_SAFE_INTEGER],
      holdMaxAgeHours: [1, 24 * 30],
    },
    whatsappCalling: {
      markupBps: [0, 100_000],
      platformFeePerMinuteMicros: [0, Number.MAX_SAFE_INTEGER],
      holdMinutes: [1, 60],
      holdExtendMinutes: [1, 60],
    },
  };

/** Problems of a settings value for its key (empty = valid). */
export const platformSettingProblems = (key: unknown, value: unknown): string[] => {
  const ranges = VALUE_RANGES[key as PlatformSettingKey] as Record<string, Range> | undefined;
  if (!ranges) return ['Unknown setting'];
  if (!value || typeof value !== 'object') return ['A value is required'];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const [field, [min, max]] of Object.entries(ranges)) {
    const n = v[field];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      problems.push(`${field} must be a whole number from ${String(min)} to ${String(max)}`);
    }
  }
  for (const field of Object.keys(v)) {
    if (!(field in ranges)) problems.push(`${field} is not a setting`);
  }
  return problems;
};

const schema = new Schema<PlatformSettingsDoc>(
  {
    key: { type: String, enum: PLATFORM_SETTING_KEYS, required: true },
    // one value shape per key (`VALUE_RANGES`)
    value: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        // document validation: `this` is the row; `updateOne(…, { runValidators })`: the query
        validator: function (v: unknown) {
          const key =
            this instanceof mongoose.Query
              ? (this.getFilter() as { key?: unknown }).key
              : (this as { key?: unknown }).key;
          return platformSettingProblems(key, v).length === 0;
        },
        message: 'Invalid settings value',
      },
    },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { minimize: false },
);
schema.plugin(basePlugin);
schema.index({ key: 1 }, { unique: true });

/** Platform-wide settings, one row per key, no `accountId` (data-model.md §2.9). Reads fall back to code defaults. */
export const PlatformSettingsModel: Model<PlatformSettingsDoc> =
  (mongoose.models.PlatformSettings as Model<PlatformSettingsDoc> | undefined) ??
  mongoose.model<PlatformSettingsDoc>('PlatformSettings', schema, 'platformSettings');
