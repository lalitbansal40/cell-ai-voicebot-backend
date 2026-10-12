import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const CALL_DIRECTIONS = ['outbound', 'inbound'] as const;
export const CALL_PROVIDERS = ['webcall', 'sip', 'notifynow'] as const;
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
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

export interface CallSource {
  kind: 'flow' | 'agent';
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
  source: CallSource;
  contactId: Types.ObjectId | null;
  campaignId: Types.ObjectId | null;
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

const schema = new Schema<CallDoc>(
  {
    direction: { type: String, enum: CALL_DIRECTIONS, required: true },
    provider: { type: String, enum: CALL_PROVIDERS, required: true },
    providerCallId: { type: String, default: null },
    from: { type: String, required: true, maxlength: 64 },
    to: { type: String, required: true, maxlength: 64 },
    isTest: { type: Boolean, default: false },
    source: { type: Schema.Types.Mixed, required: true },
    contactId: { type: Schema.Types.ObjectId, default: null },
    campaignId: { type: Schema.Types.ObjectId, default: null },
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
schema.index({ status: 1, updatedAt: 1 });
schema.index({ createdAt: 1 });

/** One phone / web call (data-model.md §2 Call — Phase 7). */
export const CallModel: Model<CallDoc> =
  (mongoose.models.Call as Model<CallDoc> | undefined) ??
  mongoose.model<CallDoc>('Call', schema, 'calls');
