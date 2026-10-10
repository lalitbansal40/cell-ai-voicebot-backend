import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import { RUN_MODES, type RunMode } from './flow-run.model';

export interface FlowNodeStatsDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  flowId: Types.ObjectId;
  /** Published version number, `0` = draft. */
  version: number;
  nodeId: string;
  /** `YYYY-MM-DD` in the account timezone. */
  day: string;
  mode: RunMode;
  entered: number;
  errorCount: number;
  totalMs: number;
  /** Exit handle → count. */
  exits: Map<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<FlowNodeStatsDoc>({
  flowId: { type: Schema.Types.ObjectId, required: true },
  version: { type: Number, required: true, min: 0 },
  nodeId: { type: String, required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  mode: { type: String, enum: RUN_MODES, required: true },
  entered: { type: Number, default: 0, min: 0 },
  errorCount: { type: Number, default: 0, min: 0 },
  totalMs: { type: Number, default: 0, min: 0 },
  exits: { type: Map, of: Number, default: () => new Map() },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ flowId: 1, version: 1, nodeId: 1, day: 1, mode: 1 }, { unique: true });

/** Per-node counters for the builder overlay and reports (atomic `$inc`). */
export const FlowNodeStatsModel: Model<FlowNodeStatsDoc> =
  (mongoose.models.FlowNodeStats as Model<FlowNodeStatsDoc> | undefined) ??
  mongoose.model<FlowNodeStatsDoc>('FlowNodeStats', schema, 'flowNodeStats');
