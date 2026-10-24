import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const CALL_DIRECTIONS = ['outbound', 'inbound'] as const;
export const CALL_PROVIDERS = ['webcall', 'sip', 'notifynow', 'dryrun', 'whatsapp'] as const;
export type CallProvider = (typeof CALL_PROVIDERS)[number];

export const CALL_STATUSES = [
  'queued',
  'ringing',
  'in_progress',
  'completed',
  'failed',
  'busy',
  'no_answer',
  'canceled',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
/** Statuses of a call that is still running (or about to). */
export const LIVE_CALL_STATUSES: readonly CallStatus[] = ['queued', 'ringing', 'in_progress'];

export const CALL_END_REASONS = [
  'hangup_node',
  'agent_end_call',
  'customer_hangup',
  'transferred',
  'max_duration',
  'wallet_empty',
  'ai_failed',
  'engine_error',
  'media_timeout',
  'media_error',
  'server_shutdown',
  'canceled',
  'limit',
  'busy',
  'no_answer',
  'invalid_number',
  'campaign_canceled',
  // WhatsApp calls (Phase 12)
  'rejected_by_customer',
  'not_answered',
  'meta_failed',
  'permission_missing',
  'calling_restricted',
  'no_agent_available',
  'outside_call_hours',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/** `ai` = a flow / AI agent talks; `human` = a team member (WhatsApp calls, Phase 12). */
export const CALL_MODES = ['ai', 'human'] as const;
export type CallMode = (typeof CALL_MODES)[number];

export const WA_CALL_DIRECTIONS = ['BUSINESS_INITIATED', 'USER_INITIATED'] as const;
export type WaCallDirection = (typeof WA_CALL_DIRECTIONS)[number];

/** Money state of a WhatsApp call (`free` = user-initiated, Meta does not bill it). */
export const WA_CALL_BILLING_STATUSES = ['free', 'held', 'settled', 'released'] as const;
export type WaCallBillingStatus = (typeof WA_CALL_BILLING_STATUSES)[number];

/** WhatsApp side of a call (PHASE_12_PLAN §1c). Never SDP, ICE data or phone numbers. */
export interface CallWhatsApp {
  channelId: Types.ObjectId;
  /** Meta's call id (`wacid.…`). */
  waCallId: string | null;
  direction: WaCallDirection;
  conversationId: Types.ObjectId | null;
  permissionId: Types.ObjectId | null;
  timeline: { event: string; at: Date }[];
  metaStatus: string | null;
  metaDuration: number | null;
  metaStartTime: Date | null;
  metaEndTime: Date | null;
  metaErrors: { code: number }[];
  ctaPayload: string | null;
  deeplinkPayload: string | null;
  ringUserIds: Types.ObjectId[];
  answeredBy: Types.ObjectId | null;
  transferredTo: Types.ObjectId | null;
}

/** Price of a business-initiated WhatsApp call (6-second pulses, plan §1j). */
export interface CallWhatsAppBilling {
  payer: 'platform' | 'customer';
  market: string;
  pulses: number;
  perMinuteMicros: number;
  metaCostMicros: number;
  markupMicros: number;
  platformFeeMicros: number;
  status: WaCallBillingStatus;
}

export interface CallSource {
  /** `null` for human WhatsApp calls (`mode: 'human'`). */
  kind: 'flow' | 'agent' | null;
  flowId?: Types.ObjectId;
  /** `'draft'` or a published version number. */
  flowVersionRef?: 'draft' | number;
  flowVersionId?: Types.ObjectId | null;
  agentId?: Types.ObjectId;
}

export interface CallLatency {
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  samples: number;
}

export interface CallMetrics {
  latency: CallLatency;
  bargeIns: number;
  silencePrompts: number;
  framesIn: number;
  framesOut: number;
  gapsIn: number;
  ttsChars: number;
  ttsCachedChars: number;
  aiSeconds: number;
  realtime: {
    inputAudioTokens: number;
    outputAudioTokens: number;
    inputTextTokens: number;
    outputTextTokens: number;
    cachedTokens: number;
  };
}

export interface CallCost {
  telephonyMicros: number;
  aiMicros: number;
  ttsMicros: number;
  commissionMicros: number;
  totalMicros: number;
}

export interface CallRecording {
  fileKey: string;
  durationSec: number;
  sizeBytes: number;
  format: 'wav';
}

export interface CallDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  direction: (typeof CALL_DIRECTIONS)[number];
  provider: CallProvider;
  providerCallId: string | null;
  /** E.164 for phone calls; `webcall` / `webcall:<userId>` for browser test calls. */
  from: string;
  to: string;
  isTest: boolean;
  mode: CallMode;
  source: CallSource;
  /** The team member on a human call (Phase 12). */
  agentUserId: Types.ObjectId | null;
  whatsapp: CallWhatsApp | null;
  billing: { whatsapp: CallWhatsAppBilling | null };
  contactId: Types.ObjectId | null;
  campaignId: Types.ObjectId | null;
  /** Campaign contact + 1-based attempt (unique together: never dial an attempt twice). */
  campaignContactId: Types.ObjectId | null;
  attempt: number | null;
  startedBy: Types.ObjectId | null;
  status: CallStatus;
  endReason: CallEndReason | null;
  hangupCause: string | null;
  timestamps: {
    queuedAt: Date;
    ringingAt: Date | null;
    answeredAt: Date | null;
    endedAt: Date | null;
  };
  durationSec: number;
  /** Display values (allowed contact fields + flow values) — never the phone or external id. */
  variables: Record<string, string>;
  /** Typed tester values (no contact): contact fields + flow variables. */
  manualVariables: Record<string, string> | null;
  /** Tester's test phone — only API steps / functions see it; never returned. */
  testPhone: string | null;
  outcome: Record<string, unknown>;
  disposition: string | null;
  languageDetected: string | null;
  metrics: CallMetrics;
  holdId: Types.ObjectId | null;
  ledgerEntryId: Types.ObjectId | null;
  cost: CallCost;
  /** `false` for dry-run calls: `cost` is what the call would have cost, no ledger rows. */
  charged: boolean;
  recording: CallRecording | null;
  flowRunId: Types.ObjectId | null;
  /** Next CallEvent / TranscriptTurn sequence numbers. */
  seq: { events: number; transcript: number };
  error: { code: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export const emptyCallMetrics = (): CallMetrics => ({
  latency: { p50Ms: null, p95Ms: null, maxMs: null, samples: 0 },
  bargeIns: 0,
  silencePrompts: 0,
  framesIn: 0,
  framesOut: 0,
  gapsIn: 0,
  ttsChars: 0,
  ttsCachedChars: 0,
  aiSeconds: 0,
  realtime: {
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedTokens: 0,
  },
});

export const emptyCallCost = (): CallCost => ({
  telephonyMicros: 0,
  aiMicros: 0,
  ttsMicros: 0,
  commissionMicros: 0,
  totalMicros: 0,
});

const objectIds = { type: [Schema.Types.ObjectId], default: [] };

const whatsappSchema = new Schema<CallWhatsApp>(
  {
    channelId: { type: Schema.Types.ObjectId, required: true },
    waCallId: { type: String, default: null, maxlength: 200 },
    direction: { type: String, enum: WA_CALL_DIRECTIONS, required: true },
    conversationId: { type: Schema.Types.ObjectId, default: null },
    permissionId: { type: Schema.Types.ObjectId, default: null },
    timeline: {
      type: [
        new Schema(
          {
            event: { type: String, required: true, maxlength: 40 },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    metaStatus: { type: String, default: null, maxlength: 40 },
    metaDuration: { type: Number, default: null, min: 0 },
    metaStartTime: { type: Date, default: null },
    metaEndTime: { type: Date, default: null },
    metaErrors: {
      type: [new Schema({ code: { type: Number, required: true } }, { _id: false })],
      default: [],
    },
    ctaPayload: { type: String, default: null, maxlength: 512 },
    deeplinkPayload: { type: String, default: null, maxlength: 512 },
    ringUserIds: objectIds,
    answeredBy: { type: Schema.Types.ObjectId, default: null },
    transferredTo: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const whatsappBillingSchema = new Schema<CallWhatsAppBilling>(
  {
    payer: { type: String, enum: ['platform', 'customer'], required: true },
    market: { type: String, required: true, maxlength: 10 },
    pulses: { type: Number, default: 0, min: 0 },
    perMinuteMicros: { type: Number, required: true, min: 0 },
    metaCostMicros: { type: Number, default: 0, min: 0 },
    markupMicros: { type: Number, default: 0, min: 0 },
    platformFeeMicros: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: WA_CALL_BILLING_STATUSES, required: true },
  },
  { _id: false },
);

const schema = new Schema<CallDoc>(
  {
    direction: { type: String, enum: CALL_DIRECTIONS, required: true },
    provider: { type: String, enum: CALL_PROVIDERS, required: true },
    providerCallId: { type: String, default: null },
    from: { type: String, required: true, maxlength: 64 },
    to: { type: String, required: true, maxlength: 64 },
    isTest: { type: Boolean, default: false },
    mode: { type: String, enum: CALL_MODES, default: 'ai' },
    source: { type: Schema.Types.Mixed, required: true },
    agentUserId: { type: Schema.Types.ObjectId, default: null },
    whatsapp: { type: whatsappSchema, default: null },
    billing: {
      whatsapp: { type: whatsappBillingSchema, default: null },
    },
    contactId: { type: Schema.Types.ObjectId, default: null },
    campaignId: { type: Schema.Types.ObjectId, default: null },
    campaignContactId: { type: Schema.Types.ObjectId, default: null },
    attempt: { type: Number, default: null, min: 1 },
    startedBy: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: CALL_STATUSES, default: 'queued', required: true },
    endReason: { type: String, enum: [...CALL_END_REASONS, null], default: null },
    hangupCause: { type: String, default: null },
    timestamps: {
      queuedAt: { type: Date, required: true },
      ringingAt: { type: Date, default: null },
      answeredAt: { type: Date, default: null },
      endedAt: { type: Date, default: null },
    },
    durationSec: { type: Number, default: 0, min: 0 },
    variables: { type: Schema.Types.Mixed, default: () => ({}) },
    manualVariables: { type: Schema.Types.Mixed, default: null },
    testPhone: { type: String, default: null, select: false },
    outcome: { type: Schema.Types.Mixed, default: () => ({}) },
    disposition: { type: String, default: null },
    languageDetected: { type: String, default: null },
    metrics: { type: Schema.Types.Mixed, default: emptyCallMetrics },
    holdId: { type: Schema.Types.ObjectId, default: null },
    ledgerEntryId: { type: Schema.Types.ObjectId, default: null },
    cost: { type: Schema.Types.Mixed, default: emptyCallCost },
    charged: { type: Boolean, default: true },
    recording: { type: Schema.Types.Mixed, default: null },
    flowRunId: { type: Schema.Types.ObjectId, default: null },
    seq: {
      events: { type: Number, default: 0 },
      transcript: { type: Number, default: 0 },
    },
    error: { type: Schema.Types.Mixed, default: null },
  },
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['testPhone'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, createdAt: -1, _id: -1 });
schema.index({ accountId: 1, status: 1 });
schema.index({ accountId: 1, campaignId: 1, status: 1 });
schema.index({ accountId: 1, contactId: 1, createdAt: -1 });
schema.index({ accountId: 1, 'source.flowId': 1, createdAt: -1 });
schema.index({ accountId: 1, 'source.agentId': 1, createdAt: -1 });
schema.index(
  { provider: 1, providerCallId: 1 },
  { unique: true, partialFilterExpression: { providerCallId: { $type: 'string' } } },
);
schema.index(
  { campaignContactId: 1, attempt: 1 },
  { unique: true, partialFilterExpression: { campaignContactId: { $type: 'objectId' } } },
);
schema.index({ accountId: 1, contactId: 1, provider: 1, createdAt: -1 });
schema.index({ status: 1, updatedAt: 1 });
schema.index(
  { 'whatsapp.waCallId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'whatsapp.waCallId': { $type: 'string' } },
    name: 'wa_call_id',
  },
);
schema.index(
  { accountId: 1, 'whatsapp.channelId': 1, createdAt: -1 },
  { partialFilterExpression: { provider: 'whatsapp' }, name: 'wa_channel_calls' },
);
schema.index({ createdAt: 1 });

/** One phone / web / WhatsApp call (data-model.md §2 Call — Phase 7, WhatsApp Phase 12). */
export const CallModel: Model<CallDoc> =
  (mongoose.models.Call as Model<CallDoc> | undefined) ??
  mongoose.model<CallDoc>('Call', schema, 'calls');
