import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES, INBOX_LIMITS, INSIGHTS_LIMITS } from '../../config/limits';
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

export const INBOX_NOTIFY_MODES = ['assigned_or_all', 'assigned_only', 'off'] as const;
export type InboxNotifyMode = (typeof INBOX_NOTIFY_MODES)[number];

/** WhatsApp inbox settings (Phase 10; owner decisions 23 Oct 2026 — PHASE_10_PLAN §7). */
export interface AccountInboxSettings {
  /** Blue ticks for the customer when the team opens a chat. */
  sendReadReceipts: boolean;
  /** Whole-message keywords, stored upper-case + NFC. */
  optOutKeywords: string[];
  optInKeywords: string[];
  optOutReply: boolean;
  optOutReplyText: string;
  optInReply: boolean;
  optInReplyText: string;
  notifyOnNewMessage: InboxNotifyMode;
}

export const DEFAULT_INBOX_SETTINGS: AccountInboxSettings = {
  sendReadReceipts: true,
  optOutKeywords: [
    'STOP',
    'STOP ALL',
    'UNSUBSCRIBE',
    'CANCEL',
    'BAND KARO',
    'BAND KARDO',
    'MAT BHEJO',
    'MESSAGE MAT BHEJO',
    'बंद करो',
    'बंद कर दो',
    'मत भेजो',
  ],
  optInKeywords: ['START', 'UNSTOP', 'SHURU', 'SHURU KARO', 'चालू करो', 'शुरू करो'],
  optOutReply: true,
  optOutReplyText:
    "You won't get more messages from us. Reply START to opt in again.\nAb aapko humse messages nahi aayenge. Dobara shuru karne ke liye START bhejein.",
  optInReply: true,
  optInReplyText: "You're subscribed again. / Aap dobara subscribe ho gaye hain.",
  notifyOnNewMessage: 'assigned_or_all',
};

/** Post-call AI (Phase 14). Human-call transcription stays in `whatsappCalling`. */
export interface AccountInsightsSettings {
  enabled: boolean;
  chatSummaryOnClose: boolean;
}

export const DEFAULT_INSIGHTS_SETTINGS: AccountInsightsSettings = {
  enabled: true,
  chatSummaryOnClose: false,
};

/** One call outcome the account uses (key stable, label editable). */
export interface AccountDisposition {
  key: string;
  label: string;
  active: boolean;
}

/** Owner default (PHASE_14_PLAN §7 #3). */
export const DEFAULT_DISPOSITIONS: AccountDisposition[] = [
  { key: 'promise_to_pay', label: 'Promise to pay', active: true },
  { key: 'paid', label: 'Paid', active: true },
  { key: 'callback', label: 'Callback requested', active: true },
  { key: 'dispute', label: 'Dispute', active: true },
  { key: 'not_interested', label: 'Not interested', active: true },
  { key: 'wrong_number', label: 'Wrong number', active: true },
  { key: 'language_barrier', label: 'Language barrier', active: true },
  { key: 'other', label: 'Other', active: true },
];

export interface AccountSettings {
  callingWindow: CallingWindow;
  callCaps: CallCaps;
  recordingEnabled: boolean;
  /** Said at the start of every recorded call (Phase 7). */
  recordingNotice: string;
  aiDisclosureEnabled: boolean;
  inbox: AccountInboxSettings;
  /** Phase 11 — absent on accounts created before migration 0012. */
  templates?: AccountTemplateSettings;
  /** Phase 12 — absent on accounts created before migration 0013. */
  whatsappCalling?: AccountWhatsAppCallingSettings;
  /** Phase 14 — absent on accounts created before migration 0016. */
  insights?: AccountInsightsSettings;
  dispositions?: AccountDisposition[];
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
  /** WhatsApp prices (Phase 11, superadmin): override of the platform markup. */
  whatsappBilling?: AccountWhatsAppBilling | null;
  /** WhatsApp call prices (Phase 12, superadmin): override of the platform calling settings. */
  whatsappCallingBilling?: AccountWhatsAppCallingBilling | null;
  /** How long this account keeps data (Phase 14); `null` = the platform default. */
  retention?: AccountRetention | null;
  /** Superadmin upper limit for this account (Phase 14); `null` = the platform default. */
  retentionCap?: AccountRetentionCap | null;
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
  inbox: DEFAULT_INBOX_SETTINGS,
};

/** Days kept (Phase 14); each `null` = the platform default (env). Recordings ≤ calls. */
export interface AccountRetention {
  recordingsDays: number | null;
  /** Call records, events, transcripts, insights, flow runs. */
  callsDays: number | null;
  /** WhatsApp messages, media and chat summaries. */
  inboxDays: number | null;
}

export interface AccountRetentionCap {
  callsDays: number | null;
  inboxDays: number | null;
}

export const DEFAULT_ACCOUNT_LIMITS: AccountLimits = { maxConcurrentCalls: 10, dialsPerMinute: 60 };

export interface AccountWhatsApp {
  /** `platform` = our credit line on the customer's WABA; `customer` = their own payment method. */
  metaPayer: 'platform' | 'customer';
}

/** Template defaults of the account (Phase 11). */
export interface AccountTemplateSettings {
  /** Meta language code preselected in the template builder. */
  defaultLanguage: string;
}

export const DEFAULT_TEMPLATE_SETTINGS: AccountTemplateSettings = { defaultLanguage: 'en' };

export const WHATSAPP_PRICE_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'service',
] as const;
export type WhatsAppPriceCategory = (typeof WHATSAPP_PRICE_CATEGORIES)[number];

/**
 * Per-account WhatsApp price override (superadmin, Phase 11). `null` fields use the
 * platform settings; `fixedPrices` (micros per message) win over the markup.
 */
export interface AccountWhatsAppBilling {
  markupBps: number | null;
  fixedPrices: Partial<Record<WhatsAppPriceCategory, number>> | null;
  platformFeeMicros: number | null;
}

export const DEFAULT_ACCOUNT_WHATSAPP_BILLING: AccountWhatsAppBilling = {
  markupBps: null,
  fixedPrices: null,
  platformFeeMicros: null,
};

/** WhatsApp call settings of the account (Phase 12, owner defaults §7 #6 / #10 / #14). */
export interface AccountWhatsAppCallingSettings {
  /** Record WhatsApp calls on our server (AI and human), with the notice below. */
  recordCalls: boolean;
  recordingNotice: string;
  /** Transcribe human (agent) WhatsApp calls. AI calls always have a transcript. */
  transcribeHumanCalls: boolean;
  /** Longest WhatsApp call (minutes), at most `CALL_LIMITS.maxCallSecHard`. */
  maxCallMinutes: number;
}

export const DEFAULT_WHATSAPP_CALLING_SETTINGS: AccountWhatsAppCallingSettings = {
  recordCalls: true,
  recordingNotice: CALL_LINES.recordingNotice,
  transcribeHumanCalls: false,
  maxCallMinutes: 30,
};

/**
 * Per-account WhatsApp call price override (superadmin, Phase 12). `null` fields
 * use the platform calling settings; `fixedPerMinuteMicros` wins over the markup.
 */
export interface AccountWhatsAppCallingBilling {
  markupBps: number | null;
  fixedPerMinuteMicros: number | null;
  platformFeePerMinuteMicros: number | null;
}

export const DEFAULT_ACCOUNT_WHATSAPP_CALLING_BILLING: AccountWhatsAppCallingBilling = {
  markupBps: null,
  fixedPerMinuteMicros: null,
  platformFeePerMinuteMicros: null,
};

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
    inbox: {
      sendReadReceipts: { type: Boolean, default: DEFAULT_INBOX_SETTINGS.sendReadReceipts },
      optOutKeywords: {
        type: [{ type: String, maxlength: INBOX_LIMITS.keywordMaxLength }],
        default: () => [...DEFAULT_INBOX_SETTINGS.optOutKeywords],
      },
      optInKeywords: {
        type: [{ type: String, maxlength: INBOX_LIMITS.keywordMaxLength }],
        default: () => [...DEFAULT_INBOX_SETTINGS.optInKeywords],
      },
      optOutReply: { type: Boolean, default: DEFAULT_INBOX_SETTINGS.optOutReply },
      optOutReplyText: {
        type: String,
        default: DEFAULT_INBOX_SETTINGS.optOutReplyText,
        maxlength: INBOX_LIMITS.replyTextMax,
      },
      optInReply: { type: Boolean, default: DEFAULT_INBOX_SETTINGS.optInReply },
      optInReplyText: {
        type: String,
        default: DEFAULT_INBOX_SETTINGS.optInReplyText,
        maxlength: INBOX_LIMITS.replyTextMax,
      },
      notifyOnNewMessage: {
        type: String,
        enum: INBOX_NOTIFY_MODES,
        default: DEFAULT_INBOX_SETTINGS.notifyOnNewMessage,
      },
    },
    templates: {
      defaultLanguage: {
        type: String,
        default: DEFAULT_TEMPLATE_SETTINGS.defaultLanguage,
        maxlength: 20,
      },
    },
    whatsappCalling: {
      recordCalls: { type: Boolean, default: DEFAULT_WHATSAPP_CALLING_SETTINGS.recordCalls },
      recordingNotice: {
        type: String,
        default: DEFAULT_WHATSAPP_CALLING_SETTINGS.recordingNotice,
        maxlength: CALL_LIMITS.recordingNoticeMaxChars,
      },
      transcribeHumanCalls: {
        type: Boolean,
        default: DEFAULT_WHATSAPP_CALLING_SETTINGS.transcribeHumanCalls,
      },
      maxCallMinutes: {
        type: Number,
        default: DEFAULT_WHATSAPP_CALLING_SETTINGS.maxCallMinutes,
        min: 1,
        max: CALL_LIMITS.maxCallSecHard / 60,
      },
    },
    insights: {
      enabled: { type: Boolean, default: DEFAULT_INSIGHTS_SETTINGS.enabled },
      chatSummaryOnClose: { type: Boolean, default: DEFAULT_INSIGHTS_SETTINGS.chatSummaryOnClose },
    },
    dispositions: {
      type: [
        new Schema<AccountDisposition>(
          {
            key: { type: String, required: true, match: /^[a-z0-9_]{1,40}$/ },
            label: { type: String, required: true, maxlength: INSIGHTS_LIMITS.dispositionLabelMax },
            active: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: () => DEFAULT_DISPOSITIONS.map((d) => ({ ...d })),
    },
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
  whatsappBilling: {
    type: new Schema<AccountWhatsAppBilling>(
      {
        markupBps: { type: Number, default: null, min: 0, max: 100_000 },
        fixedPrices: {
          type: new Schema(
            Object.fromEntries(WHATSAPP_PRICE_CATEGORIES.map((c) => [c, { type: Number, min: 0 }])),
            { _id: false },
          ),
          default: null,
        },
        platformFeeMicros: { type: Number, default: null, min: 0 },
      },
      { _id: false },
    ),
    default: null,
  },
  whatsappCallingBilling: {
    type: new Schema<AccountWhatsAppCallingBilling>(
      {
        markupBps: { type: Number, default: null, min: 0, max: 100_000 },
        fixedPerMinuteMicros: { type: Number, default: null, min: 0 },
        platformFeePerMinuteMicros: { type: Number, default: null, min: 0 },
      },
      { _id: false },
    ),
    default: null,
  },
  retention: {
    type: new Schema<AccountRetention>(
      {
        recordingsDays: { type: Number, default: null, min: 1 },
        callsDays: { type: Number, default: null, min: 1 },
        inboxDays: { type: Number, default: null, min: 1 },
      },
      { _id: false },
    ),
    default: null,
  },
  retentionCap: {
    type: new Schema<AccountRetentionCap>(
      {
        callsDays: { type: Number, default: null, min: 1 },
        inboxDays: { type: Number, default: null, min: 1 },
      },
      { _id: false },
    ),
    default: null,
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
