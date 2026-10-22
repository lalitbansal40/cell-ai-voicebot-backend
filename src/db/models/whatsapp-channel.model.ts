import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
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

export const WA_QUALITY = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
export type WaQuality = (typeof WA_QUALITY)[number];

export const WA_LIMIT_TIERS = [
  'TIER_50',
  'TIER_250',
  'TIER_1K',
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

const schema = new Schema<WhatsAppChannelDoc>({
  label: { type: String, required: true, trim: true, maxlength: WHATSAPP_LIMITS.labelMax },
  provider: { type: String, enum: WA_PROVIDERS, required: true },
  mode: { type: String, enum: WA_MODES, required: true },
  wabaId: { type: String, required: true, maxlength: 64 },
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
schema.index({ metaUserId: 1 });

/** A WhatsApp Business number connected to an account (PHASE_9_PLAN §1e). */
export const WhatsAppChannelModel: Model<WhatsAppChannelDoc> =
  (mongoose.models.WhatsAppChannel as Model<WhatsAppChannelDoc> | undefined) ??
  mongoose.model<WhatsAppChannelDoc>('WhatsAppChannel', schema, 'whatsappChannels');
