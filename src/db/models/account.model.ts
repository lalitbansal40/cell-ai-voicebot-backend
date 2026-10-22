import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES } from '../../config/limits';
import { basePlugin } from '../plugins/base';

export type AccountStatus = 'active' | 'suspended';
export type AccountLanguage = 'hi' | 'en' | 'hinglish';

export interface CallingWindow {
  /** Local time `HH:mm` in the account timezone. */
  start: string;
  end: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
}

/** Per-contact call caps across all campaigns and single calls (Phase 8). */
export interface CallCaps {
  perDay: number;
  perWeek: number;
  /** Minimum minutes between two calls to the same contact. */
  minGapMinutes: number;
}

/** Dialing limits set by a superadmin per account (Phase 8). */
export interface AccountLimits {
  maxConcurrentCalls: number;
  dialsPerMinute: number;
}

export interface AccountSettings {
  callingWindow: CallingWindow;
  callCaps: CallCaps;
  recordingEnabled: boolean;
  /** Said at the start of every recorded call (Phase 7). */
  recordingNotice: string;
  aiDisclosureEnabled: boolean;
}

/** GST billing details (PHASE_4_PLAN §1d) — buyer on invoices. Latin text only (PDF). */
export interface BillingProfile {
  legalName: string;
  email: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  /** GST state code (`08` = Rajasthan) — place of supply. */
  stateCode: string;
  pin: string;
  gstin: string | null;
}

const BILLING_PROFILE_FIELDS = {
  legalName: { type: String, required: true, maxlength: 120 },
  email: { type: String, required: true, maxlength: 254 },
  addressLine1: { type: String, required: true, maxlength: 120 },
  addressLine2: { type: String, default: null, maxlength: 120 },
  city: { type: String, required: true, maxlength: 60 },
  stateCode: { type: String, required: true, minlength: 2, maxlength: 2 },
  pin: { type: String, required: true, minlength: 6, maxlength: 6 },
  gstin: { type: String, default: null, maxlength: 15 },
};

export const BILLING_PROFILE_SCHEMA = new Schema<BillingProfile>(BILLING_PROFILE_FIELDS, {
  _id: false,
});

export interface AccountDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  status: AccountStatus;
  suspendedAt?: Date | null;
  suspendReason?: string | null;
  ownerId?: Types.ObjectId | null;
  /** The internal `platform` account that holds superadmins. */
  isPlatform: boolean;
  timezone: string;
  country: string;
  defaultLanguage: AccountLanguage;
  settings: AccountSettings;
  limits: AccountLimits;
  /** WhatsApp (Phase 9): who pays Meta for numbers connected from now on (superadmin setting). */
  whatsapp: AccountWhatsApp;
  billing?: (BillingProfile & { updatedAt: Date }) | null;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  callingWindow: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
  callCaps: { perDay: 3, perWeek: 10, minGapMinutes: 30 },
  recordingEnabled: true,
  recordingNotice: CALL_LINES.recordingNotice,
  aiDisclosureEnabled: true,
};

export const DEFAULT_ACCOUNT_LIMITS: AccountLimits = { maxConcurrentCalls: 10, dialsPerMinute: 60 };

export interface AccountWhatsApp {
  /** `platform` = our credit line on the customer's WABA; `customer` = their own payment method. */
  metaPayer: 'platform' | 'customer';
}

export const DEFAULT_ACCOUNT_WHATSAPP: AccountWhatsApp = { metaPayer: 'platform' };

const schema = new Schema<AccountDoc>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 60 },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
  suspendedAt: { type: Date, default: null },
  suspendReason: { type: String, default: null, maxlength: 200 },
  ownerId: { type: Schema.Types.ObjectId, default: null },
  isPlatform: { type: Boolean, default: false },
  timezone: { type: String, default: 'Asia/Kolkata', required: true },
  country: {
    type: String,
    default: 'IN',
    required: true,
    uppercase: true,
    minlength: 2,
    maxlength: 2,
  },
  defaultLanguage: {
    type: String,
    enum: ['hi', 'en', 'hinglish'],
    default: 'hinglish',
    required: true,
  },
  settings: {
    callingWindow: {
      start: { type: String, default: DEFAULT_ACCOUNT_SETTINGS.callingWindow.start },
      end: { type: String, default: DEFAULT_ACCOUNT_SETTINGS.callingWindow.end },
      days: { type: [Number], default: DEFAULT_ACCOUNT_SETTINGS.callingWindow.days },
    },
    callCaps: {
      perDay: { type: Number, default: DEFAULT_ACCOUNT_SETTINGS.callCaps.perDay },
      perWeek: { type: Number, default: DEFAULT_ACCOUNT_SETTINGS.callCaps.perWeek },
      minGapMinutes: {
        type: Number,
        default: DEFAULT_ACCOUNT_SETTINGS.callCaps.minGapMinutes,
      },
    },
    recordingEnabled: { type: Boolean, default: true },
    recordingNotice: {
      type: String,
      default: CALL_LINES.recordingNotice,
      maxlength: CALL_LIMITS.recordingNoticeMaxChars,
    },
    aiDisclosureEnabled: { type: Boolean, default: true },
  },
  limits: {
    maxConcurrentCalls: { type: Number, default: DEFAULT_ACCOUNT_LIMITS.maxConcurrentCalls },
    dialsPerMinute: { type: Number, default: DEFAULT_ACCOUNT_LIMITS.dialsPerMinute },
  },
  whatsapp: {
    metaPayer: {
      type: String,
      enum: ['platform', 'customer'],
      default: DEFAULT_ACCOUNT_WHATSAPP.metaPayer,
    },
  },
  billing: {
    type: new Schema<BillingProfile & { updatedAt: Date }>(
      { ...BILLING_PROFILE_FIELDS, updatedAt: { type: Date, required: true } },
      { _id: false },
    ),
    default: null,
  },
});
schema.plugin(basePlugin);
schema.index({ slug: 1 }, { unique: true });
schema.index({ status: 1 });

/** The tenant (data-model.md §2.1). Not tenant-scoped itself. */
export const AccountModel: Model<AccountDoc> =
  (mongoose.models.Account as Model<AccountDoc> | undefined) ??
  mongoose.model<AccountDoc>('Account', schema, 'accounts');
