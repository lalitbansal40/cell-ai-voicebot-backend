import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WHATSAPP_CALL_LIMITS, WHATSAPP_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const WA_CHANNEL_STATUSES = [
  'connecting',
  'connected',
  'action_needed',
  'needs_reconnect',
  'restricted',
  'disconnected',
] as const;
export type WaChannelStatus = (typeof WA_CHANNEL_STATUSES)[number];
/** Statuses that hold the phone number (the partial unique index covers them). */
export const WA_ACTIVE_STATUSES = WA_CHANNEL_STATUSES.filter((s) => s !== 'disconnected');

export const WA_MODES = ['cloud_api', 'coexistence'] as const;
export type WaMode = (typeof WA_MODES)[number];

/** What `wabaId` points at (Meta's account model evolution, Phase 1 from H2 2026). */
export const WA_WABA_KINDS = ['whatsapp', 'messaging'] as const;
export type WaWabaKind = (typeof WA_WABA_KINDS)[number];

export const WA_QUALITY = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
export type WaQuality = (typeof WA_QUALITY)[number];

export const WA_LIMIT_TIERS = [
  'TIER_50',
  'TIER_250',
  'TIER_1K',
  // Meta's tier since late 2025 (replaces 1K); calling needs 2,000 or more
  'TIER_2K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
] as const;
export type WaLimitTier = (typeof WA_LIMIT_TIERS)[number];

export const META_PAYERS = ['platform', 'customer'] as const;
export type MetaPayer = (typeof META_PAYERS)[number];

export const SYNC_STATUSES = [
  'not_requested',
  'requested',
  'received',
  'declined',
  'failed',
] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const WA_PROVIDERS = ['meta', 'fake'] as const;
export type WaProvider = (typeof WA_PROVIDERS)[number];

export const REGISTRATION_STATUSES = ['not_needed', 'pending', 'registered', 'failed'] as const;
export const CREDIT_LINE_STATUSES = ['not_needed', 'attached', 'failed'] as const;
export const SUBSCRIPTION_STATUSES = ['subscribed', 'failed'] as const;

/** The connect steps (`statusReason.step`; retry-setup resumes from it). */
export const CONNECT_STEPS = ['phone', 'details', 'subscribe', 'billing', 'register'] as const;
export type ConnectStep = (typeof CONNECT_STEPS)[number];

export interface WaStatusReason {
  code: string;
  message: string;
  step?: ConnectStep | null;
}

/** Meta volume pricing tier (`VOLUME_BASED_PRICING_TIER_UPDATE`, Phase 11) — newest last. */
export interface WaPricingTier {
  category: string;
  market: string | null;
  tier: string;
  at: Date;
}

/* ── WhatsApp calling (Phase 12, PHASE_12_PLAN §1c) ───────────────────────── */

export const WA_CALLING_STATUSES = ['disabled', 'enabled', 'unavailable'] as const;
export type WaCallingStatus = (typeof WA_CALLING_STATUSES)[number];

export const WA_CALLING_UNAVAILABLE_REASONS = [
  'coexistence',
  'country',
  'messaging_limit',
  'not_cloud_api',
] as const;
export type WaCallingUnavailableReason = (typeof WA_CALLING_UNAVAILABLE_REASONS)[number];

export const CALL_ICON_VISIBILITY = ['DEFAULT', 'DISABLE_ALL'] as const;
export const WEEK_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export const INBOUND_ROUTES = ['team', 'ai', 'ai_then_team'] as const;
export type InboundRoute = (typeof INBOUND_ROUTES)[number];

/** Meta's time format (`HHMM`, 24 h). */
export const HHMM_PATTERN = /^([01]\d|2[0-3])[0-5]\d$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO2_PATTERN = /^[A-Z]{2}$/;

export interface CallHoursEntry {
  day: WeekDay;
  open: string;
  close: string;
}

export interface CallHoliday {
  date: string;
  start: string;
  end: string;
}

export interface CallHours {
  enabled: boolean;
  timezone: string;
  weekly: CallHoursEntry[];
  holidays: CallHoliday[];
}

export interface WaCallingRestriction {
  type: string;
  reason: string | null;
  expiresAt: Date | null;
}

export interface WaCallingInbound {
  route: InboundRoute;
  aiProgram: { kind: 'flow' | 'agent'; id: Types.ObjectId } | null;
  ringTimeoutSec: number;
  /** `null` = every eligible online team member. */
  ringUserIds: Types.ObjectId[] | null;
}

export interface WaCalling {
  status: WaCallingStatus;
  unavailableReason: WaCallingUnavailableReason | null;
  callIconVisibility: (typeof CALL_ICON_VISIBILITY)[number];
  /** ISO-2 countries where the call icon shows (`[]` = everywhere). */
  iconCountries: string[];
  callHours: CallHours;
  callbackPermission: boolean;
  inbound: WaCallingInbound;
  /** Body of the call permission request (owner default §7 #15, editable per number). */
  permissionRequestBody: string;
  restrictions: WaCallingRestriction[];
  syncedAt: Date | null;
  lastError: string | null;
}

export const DEFAULT_PERMISSION_REQUEST_BODY =
  'Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai.';

export const defaultCalling = (
  unavailableReason: WaCallingUnavailableReason | null = null,
): WaCalling => ({
  status: unavailableReason ? 'unavailable' : 'disabled',
  unavailableReason,
  callIconVisibility: 'DEFAULT',
  iconCountries: [],
  callHours: { enabled: false, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
  callbackPermission: false,
  inbound: {
    route: 'team',
    aiProgram: null,
    ringTimeoutSec: WHATSAPP_CALL_LIMITS.uicRingTimeoutSec,
    ringUserIds: null,
  },
  permissionRequestBody: DEFAULT_PERMISSION_REQUEST_BODY,
  restrictions: [],
  syncedAt: null,
  lastError: null,
});

/** Problems of call hours (empty = valid) — Meta's rules, shared by the model and the API. */
export const callHoursProblems = (hours: Pick<CallHours, 'weekly' | 'holidays'>): string[] => {
  const problems: string[] = [];
  for (const day of WEEK_DAYS) {
    const entries = hours.weekly.filter((e) => e.day === day);
    if (entries.length > WHATSAPP_CALL_LIMITS.callHoursEntriesPerDayMax) {
      problems.push(
        `At most ${String(WHATSAPP_CALL_LIMITS.callHoursEntriesPerDayMax)} time ranges on ${day}`,
      );
    }
    const sorted = [...entries].sort((a, b) => a.open.localeCompare(b.open));
    for (const [i, e] of sorted.entries()) {
      if (e.open >= e.close)
        problems.push(`${day}: the opening time must be before the closing time`);
      const next = sorted[i + 1];
      if (next && next.open < e.close) problems.push(`${day}: time ranges overlap`);
    }
  }
  if (hours.holidays.length > WHATSAPP_CALL_LIMITS.holidaysMax) {
    problems.push(`At most ${String(WHATSAPP_CALL_LIMITS.holidaysMax)} holidays`);
  }
  const dates = new Set<string>();
  for (const h of hours.holidays) {
    if (h.start >= h.end) problems.push(`${h.date}: the start time must be before the end time`);
    if (dates.has(h.date)) problems.push(`${h.date} is listed twice`);
    dates.add(h.date);
  }
  return problems;
};

export interface WaHistoryEntry {
  status: WaChannelStatus;
  reason: string | null;
  at: Date;
  by: Types.ObjectId | null;
}

export interface WhatsAppChannelDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  label: string;
  provider: WaProvider;
  mode: WaMode;
  wabaId: string;
  /**
   * Phase 13 (Meta's account model, 2026): `messaging` when Meta named the WhatsApp
   * account separately (`waacId`), so `wabaId` is the Messaging account; null = unknown.
   */
  wabaKind: WaWabaKind | null;
  /** The WhatsApp account id when Meta sends it apart from the Messaging account. */
  waacId: string | null;
  wabaName: string | null;
  businessId: string | null;
  businessName: string | null;
  wabaCurrency: string | null;
  wabaTimezoneId: string | null;
  templateNamespace: string | null;
  wabaReviewStatus: string | null;
  businessVerificationStatus: string | null;
  /** Null while a WABA has no number yet (`FINISH_ONLY_WABA`). */
  phoneNumberId: string | null;
  phoneE164: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  newNameStatus: string | null;
  qualityRating: WaQuality;
  messagingLimitTier: WaLimitTier | null;
  throughputLevel: string | null;
  accountMode: string | null;
  platformType: string | null;
  codeVerificationStatus: string | null;
  phoneStatus: string | null;
  isOfficialBusinessAccount: boolean;
  /** WhatsApp Business app number (coexistence) — calling is not available. */
  isOnBizApp: boolean;
  capabilities: Record<string, unknown> | null;
  tokenSealed?: string | null;
  tokenType: string | null;
  tokenScopes: string[];
  tokenExpiresAt: Date | null;
  tokenCheckedAt: Date | null;
  /** Meta user that granted access (deauthorize / data deletion callbacks). */
  metaUserId: string | null;
  registration: {
    status: (typeof REGISTRATION_STATUSES)[number];
    pinSealed?: string | null;
    error: string | null;
    at: Date | null;
  };
  subscription: {
    status: (typeof SUBSCRIPTION_STATUSES)[number] | null;
    error: string | null;
    at: Date | null;
  };
  metaPayer: MetaPayer;
  creditLine: {
    status: (typeof CREDIT_LINE_STATUSES)[number];
    allocationConfigId: string | null;
    error: string | null;
    at: Date | null;
  };
  /** Customer pays Meta: a payment method is on the WhatsApp account (null = unknown / n.a.). */
  paymentMethodOk: boolean | null;
  coexistence: {
    contactsSync: SyncStatus;
    historySync: SyncStatus;
    historyProgress: number | null;
    echoesAt: Date | null;
  };
  status: WaChannelStatus;
  statusReason: WaStatusReason | null;
  restriction: { type: string; until: Date | null } | null;
  webhook: { lastEventAt: Date | null; lastField: string | null };
  /** Last 10 volume pricing tier updates (Phase 11). */
  pricingTier?: WaPricingTier[];
  /** WhatsApp calling (Phase 12) — absent on channels created before migration 0013. */
  calling?: WaCalling;
  history: WaHistoryEntry[];
  connectedBy: Types.ObjectId | null;
  connectedAt: Date | null;
  syncedAt: Date | null;
  disconnectedBy: Types.ObjectId | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const nullableString = { type: String, default: null };

const hhmm = { type: String, required: true, match: HHMM_PATTERN };

const callingSchema = new Schema<WaCalling>(
  {
    status: { type: String, enum: WA_CALLING_STATUSES, default: 'disabled' },
    unavailableReason: {
      type: String,
      enum: [...WA_CALLING_UNAVAILABLE_REASONS, null],
      default: null,
    },
    callIconVisibility: { type: String, enum: CALL_ICON_VISIBILITY, default: 'DEFAULT' },
    iconCountries: {
      type: [{ type: String, match: ISO2_PATTERN }],
      default: [],
      validate: {
        validator: (v: string[]) => new Set(v).size === v.length && v.length <= 250,
        message: 'Countries must be unique',
      },
    },
    callHours: {
      type: new Schema<CallHours>(
        {
          enabled: { type: Boolean, default: false },
          timezone: { type: String, default: 'Asia/Kolkata', maxlength: 64 },
          weekly: {
            type: [
              new Schema<CallHoursEntry>(
                { day: { type: String, enum: WEEK_DAYS, required: true }, open: hhmm, close: hhmm },
                { _id: false },
              ),
            ],
            default: [],
          },
          holidays: {
            type: [
              new Schema<CallHoliday>(
                {
                  date: { type: String, required: true, match: ISO_DATE_PATTERN },
                  start: hhmm,
                  end: hhmm,
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
      default: () => defaultCalling().callHours,
      validate: {
        validator: (v: CallHours) => callHoursProblems(v).length === 0,
        message: (props: { value: CallHours }) => callHoursProblems(props.value).join('; '),
      },
    },
    callbackPermission: { type: Boolean, default: false },
    inbound: {
      route: { type: String, enum: INBOUND_ROUTES, default: 'team' },
      aiProgram: {
        type: new Schema(
          {
            kind: { type: String, enum: ['flow', 'agent'], required: true },
            id: { type: Schema.Types.ObjectId, required: true },
          },
          { _id: false },
        ),
        default: null,
      },
      ringTimeoutSec: {
        type: Number,
        default: WHATSAPP_CALL_LIMITS.uicRingTimeoutSec,
        min: 10,
        max: 60,
      },
      ringUserIds: {
        type: [Schema.Types.ObjectId],
        default: null,
        validate: {
          validator: (v: Types.ObjectId[] | null) =>
            v === null || v.length <= WHATSAPP_CALL_LIMITS.ringTargetsMax,
          message: `At most ${String(WHATSAPP_CALL_LIMITS.ringTargetsMax)} team members`,
        },
      },
    },
    permissionRequestBody: {
      type: String,
      default: DEFAULT_PERMISSION_REQUEST_BODY,
      maxlength: WHATSAPP_CALL_LIMITS.requestBodyMax,
    },
    restrictions: {
      type: [
        new Schema<WaCallingRestriction>(
          {
            type: { type: String, required: true, maxlength: 60 },
            reason: { type: String, default: null, maxlength: 300 },
            expiresAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    syncedAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 300 },
  },
  { _id: false },
);

const schema = new Schema<WhatsAppChannelDoc>({
  label: { type: String, required: true, trim: true, maxlength: WHATSAPP_LIMITS.labelMax },
  provider: { type: String, enum: WA_PROVIDERS, required: true },
  mode: { type: String, enum: WA_MODES, required: true },
  wabaId: { type: String, required: true, maxlength: 64 },
  wabaKind: { type: String, enum: [...WA_WABA_KINDS, null], default: null },
  waacId: { type: String, default: null, maxlength: 64 },
  wabaName: nullableString,
  businessId: nullableString,
  businessName: nullableString,
  wabaCurrency: nullableString,
  wabaTimezoneId: nullableString,
  templateNamespace: nullableString,
  wabaReviewStatus: nullableString,
  businessVerificationStatus: nullableString,
  phoneNumberId: { type: String, default: null, maxlength: 64 },
  phoneE164: nullableString,
  displayPhoneNumber: nullableString,
  verifiedName: nullableString,
  nameStatus: nullableString,
  newNameStatus: nullableString,
  qualityRating: { type: String, enum: WA_QUALITY, default: 'UNKNOWN' },
  messagingLimitTier: { type: String, enum: [...WA_LIMIT_TIERS, null], default: null },
  throughputLevel: nullableString,
  accountMode: nullableString,
  platformType: nullableString,
  codeVerificationStatus: nullableString,
  phoneStatus: nullableString,
  isOfficialBusinessAccount: { type: Boolean, default: false },
  isOnBizApp: { type: Boolean, default: false },
  capabilities: { type: Schema.Types.Mixed, default: null },
  tokenSealed: { type: String, default: null, select: false },
  tokenType: nullableString,
  tokenScopes: { type: [String], default: [] },
  tokenExpiresAt: { type: Date, default: null },
  tokenCheckedAt: { type: Date, default: null },
  metaUserId: nullableString,
  registration: {
    status: { type: String, enum: REGISTRATION_STATUSES, default: 'not_needed' },
    pinSealed: { type: String, default: null, select: false },
    error: nullableString,
    at: { type: Date, default: null },
  },
  subscription: {
    status: { type: String, enum: [...SUBSCRIPTION_STATUSES, null], default: null },
    error: nullableString,
    at: { type: Date, default: null },
  },
  metaPayer: { type: String, enum: META_PAYERS, required: true },
  creditLine: {
    status: { type: String, enum: CREDIT_LINE_STATUSES, default: 'not_needed' },
    allocationConfigId: nullableString,
    error: nullableString,
    at: { type: Date, default: null },
  },
  paymentMethodOk: { type: Boolean, default: null },
  coexistence: {
    contactsSync: { type: String, enum: SYNC_STATUSES, default: 'not_requested' },
    historySync: { type: String, enum: SYNC_STATUSES, default: 'not_requested' },
    historyProgress: { type: Number, default: null },
    echoesAt: { type: Date, default: null },
  },
  status: { type: String, enum: WA_CHANNEL_STATUSES, required: true },
  statusReason: {
    type: new Schema<WaStatusReason>(
      {
        code: { type: String, required: true, maxlength: 60 },
        message: { type: String, required: true, maxlength: 300 },
        step: { type: String, enum: [...CONNECT_STEPS, null], default: null },
      },
      { _id: false },
    ),
    default: null,
  },
  restriction: {
    type: new Schema(
      { type: { type: String, required: true }, until: { type: Date, default: null } },
      { _id: false },
    ),
    default: null,
  },
  webhook: {
    lastEventAt: { type: Date, default: null },
    lastField: nullableString,
  },
  pricingTier: {
    type: [
      new Schema<WaPricingTier>(
        {
          category: { type: String, required: true, maxlength: 60 },
          market: { type: String, default: null, maxlength: 60 },
          tier: { type: String, required: true, maxlength: 60 },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  calling: { type: callingSchema, default: () => defaultCalling() },
  history: {
    type: [
      new Schema<WaHistoryEntry>(
        {
          status: { type: String, enum: WA_CHANNEL_STATUSES, required: true },
          reason: { type: String, default: null, maxlength: 300 },
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, default: null },
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  connectedBy: { type: Schema.Types.ObjectId, default: null },
  connectedAt: { type: Date, default: null },
  syncedAt: { type: Date, default: null },
  disconnectedBy: { type: Schema.Types.ObjectId, default: null },
  disconnectedAt: { type: Date, default: null },
});
// coexistence numbers (WhatsApp Business app) can't use calling (Meta)
schema.pre('validate', function () {
  if (this.isNew && this.mode === 'coexistence' && this.calling?.status === 'disabled') {
    this.calling.status = 'unavailable';
    this.calling.unavailableReason = 'coexistence';
  }
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin, { hide: ['tokenSealed'] });
// one active channel per number platform-wide (a disconnected one may be connected again elsewhere)
schema.index(
  { phoneNumberId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: WA_ACTIVE_STATUSES },
      phoneNumberId: { $type: 'string' },
    },
  },
);
schema.index({ accountId: 1, status: 1 });
schema.index({ wabaId: 1 });
schema.index(
  { accountId: 1, waacId: 1 },
  { name: 'account_waac', partialFilterExpression: { waacId: { $type: 'string' } } },
);
schema.index({ metaUserId: 1 });

/** A WhatsApp Business number connected to an account (PHASE_9_PLAN §1e). */
export const WhatsAppChannelModel: Model<WhatsAppChannelDoc> =
  (mongoose.models.WhatsAppChannel as Model<WhatsAppChannelDoc> | undefined) ??
  mongoose.model<WhatsAppChannelDoc>('WhatsAppChannel', schema, 'whatsappChannels');
