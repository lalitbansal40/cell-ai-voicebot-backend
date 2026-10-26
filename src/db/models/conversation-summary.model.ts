import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { INSIGHT_STATUSES, type InsightStatus } from './call.model';

export interface ConversationSummaryDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  conversationId: Types.ObjectId;
  status: InsightStatus;
  reason: string | null;
  /** The messages it covers (oldest → newest; the next summary starts after `toMessageId`). */
  fromMessageId: Types.ObjectId | null;
  toMessageId: Types.ObjectId | null;
  messageCount: number;
  /** Customer data — never logged. */
  summary: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** `null` = made on close (automatic). */
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ConversationSummaryDoc>({
  conversationId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: INSIGHT_STATUSES, required: true },
  reason: { type: String, default: null, maxlength: 40 },
  fromMessageId: { type: Schema.Types.ObjectId, default: null },
  toMessageId: { type: Schema.Types.ObjectId, default: null },
  messageCount: { type: Number, default: 0, min: 0 },
  summary: { type: String, default: null, maxlength: 2000 },
  model: { type: String, default: null, maxlength: 64 },
  inputTokens: { type: Number, default: 0, min: 0 },
  outputTokens: { type: Number, default: 0, min: 0 },
  costMicros: { type: Number, default: 0, min: 0 },
  createdBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, conversationId: 1, createdAt: -1 });
// inbox retention
schema.index({ createdAt: 1 });

/** WhatsApp chat summaries (Phase 14, ADR 0044). PII: `summary`. */
export const ConversationSummaryModel: Model<ConversationSummaryDoc> =
  (mongoose.models.ConversationSummary as Model<ConversationSummaryDoc> | undefined) ??
  mongoose.model<ConversationSummaryDoc>('ConversationSummary', schema, 'conversationSummaries');
