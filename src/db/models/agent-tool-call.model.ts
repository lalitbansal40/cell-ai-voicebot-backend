import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const TOOL_CALL_STATUSES = ['ok', 'error'] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/** Kept 90 days (data.md retention). */
export const TOOL_CALL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface AgentToolCallDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  agentId: Types.ObjectId;
  sessionId: Types.ObjectId | null;
  /** `test` for the function Test button. */
  source: 'playground' | 'test' | 'call';
  tool: string;
  kind: 'custom' | 'built_in';
  /** Arguments with personal values masked. */
  argsRedacted: Record<string, unknown>;
  status: ToolCallStatus;
  httpStatus: number | null;
  durationMs: number;
  resultBytes: number;
  resultPreview: string | null;
  errorCode: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<AgentToolCallDoc>({
  agentId: { type: Schema.Types.ObjectId, required: true },
  sessionId: { type: Schema.Types.ObjectId, default: null },
  source: { type: String, enum: ['playground', 'test', 'call'], required: true },
  tool: { type: String, required: true, maxlength: 60 },
  kind: { type: String, enum: ['custom', 'built_in'], required: true },
  argsRedacted: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: TOOL_CALL_STATUSES, required: true },
  httpStatus: { type: Number, default: null },
  durationMs: { type: Number, default: 0, min: 0 },
  resultBytes: { type: Number, default: 0, min: 0 },
  resultPreview: { type: String, default: null, maxlength: 500 },
  errorCode: { type: String, default: null, maxlength: 60 },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, agentId: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Log of agent tool executions (no headers, redacted previews) — 90 days. */
export const AgentToolCallModel: Model<AgentToolCallDoc> =
  (mongoose.models.AgentToolCall as Model<AgentToolCallDoc> | undefined) ??
  mongoose.model<AgentToolCallDoc>('AgentToolCall', schema, 'agentToolCalls');
