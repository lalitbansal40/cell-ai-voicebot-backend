import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export interface AgentUsageDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  agentId: Types.ObjectId;
  /** Account-timezone day `YYYY-MM-DD` and month `YYYY-MM`. */
  day: string;
  month: string;
  spentMicros: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  updatedAt: Date;
}

const counter = { type: Number, default: 0, min: 0 };

const schema = new Schema<AgentUsageDoc>({
  agentId: { type: Schema.Types.ObjectId, required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  spentMicros: counter,
  turns: counter,
  inputTokens: counter,
  outputTokens: counter,
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ agentId: 1, day: 1 }, { unique: true });
schema.index({ accountId: 1, agentId: 1, month: 1 });

/** Per-agent spend counters for caps and the UI (atomic `$inc`). */
export const AgentUsageModel: Model<AgentUsageDoc> =
  (mongoose.models.AgentUsage as Model<AgentUsageDoc> | undefined) ??
  mongoose.model<AgentUsageDoc>('AgentUsage', schema, 'agentUsage');
