import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { INSIGHT_STATUSES, type InsightStatus, type Sentiment } from './call.model';

/** What the model returned (validated, amounts converted to micros in code). Customer data. */
export interface CallInsightOutput {
  summary: string;
  suggestedDisposition: string | null;
  sentiment: { label: Sentiment; score: number };
  keyInfo: {
    promiseDate: string | null;
    promiseAmountMicros: number | null;
    callbackAt: string | null;
    disputeReason: string | null;
    wrongNumber: boolean;
    languagePreference: string | null;
    notes: string | null;
  };
  confidence: { disposition: number; promise: number; sentiment: number };
}

export interface CallInsightDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  callId: Types.ObjectId;
  /** 1 = the automatic run; each "Regenerate" adds one (all kept). */
  version: number;
  status: InsightStatus;
  reason: string | null;
  output: CallInsightOutput | null;
  model: string | null;
  promptVersion: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  ledgerEntryId: Types.ObjectId | null;
  /** The person who asked for a regenerate; `null` = automatic. */
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<CallInsightDoc>(
  {
    callId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: INSIGHT_STATUSES, required: true },
    reason: { type: String, default: null, maxlength: 40 },
    output: { type: Schema.Types.Mixed, default: null },
    model: { type: String, default: null, maxlength: 64 },
    promptVersion: { type: Number, default: 1 },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    costMicros: { type: Number, default: 0, min: 0 },
    ledgerEntryId: { type: Schema.Types.ObjectId, default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { minimize: false },
);
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, callId: 1, version: 1 }, { unique: true });
schema.index({ accountId: 1, createdAt: -1 });

/** Post-call AI results per call and version (Phase 14, ADR 0044). PII: summary, key info. */
export const CallInsightModel: Model<CallInsightDoc> =
  (mongoose.models.CallInsight as Model<CallInsightDoc> | undefined) ??
  mongoose.model<CallInsightDoc>('CallInsight', schema, 'callInsights');
