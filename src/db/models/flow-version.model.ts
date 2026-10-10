import mongoose, { Schema, type Model, type Query, type Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

import type { FlowGraphData } from './flow.model';

export interface FlowVersionDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  flowId: Types.ObjectId;
  version: number;
  graph: FlowGraphData;
  /** sha256 of the canonical graph JSON. */
  checksum: string;
  notes: string | null;
  agentIds: Types.ObjectId[];
  audioIds: Types.ObjectId[];
  publishedBy: Types.ObjectId | null;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown by every write that would change a published version. */
export class FlowVersionImmutableError extends Error {
  constructor() {
    super('Published flow versions cannot be changed');
    this.name = 'FlowVersionImmutableError';
  }
}

const schema = new Schema<FlowVersionDoc>(
  {
    flowId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    graph: { type: Schema.Types.Mixed, required: true },
    checksum: { type: String, required: true },
    notes: { type: String, default: null, maxlength: FLOW_LIMITS.versionNotesMaxChars },
    agentIds: { type: [Schema.Types.ObjectId], default: [] },
    audioIds: { type: [Schema.Types.ObjectId], default: [] },
    publishedBy: { type: Schema.Types.ObjectId, default: null },
    publishedAt: { type: Date, required: true },
  },
  { minimize: false },
);
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ flowId: 1, version: 1 }, { unique: true });
schema.index({ accountId: 1, agentIds: 1 });
schema.index({ accountId: 1, audioIds: 1 });

// Published = immutable: only inserts and deletes (purge) are allowed.
const refuse = function (this: Query<unknown, unknown>) {
  throw new FlowVersionImmutableError();
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
] as const) {
  schema.pre(op, refuse);
}
schema.pre('save', function () {
  if (!this.isNew) throw new FlowVersionImmutableError();
});

/** Published flow versions — immutable (data-model.md §2.4). */
export const FlowVersionModel: Model<FlowVersionDoc> =
  (mongoose.models.FlowVersion as Model<FlowVersionDoc> | undefined) ??
  mongoose.model<FlowVersionDoc>('FlowVersion', schema, 'flowVersions');
