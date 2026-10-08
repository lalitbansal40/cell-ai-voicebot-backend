import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export interface SegmentDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  /** `ContactFilter` (validated by the segments module before saving). */
  filter: Record<string, unknown>;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<SegmentDoc>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  filter: { type: Schema.Types.Mixed, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

/** Saved contact filters (data-model.md §2.2). */
export const SegmentModel: Model<SegmentDoc> =
  (mongoose.models.Segment as Model<SegmentDoc> | undefined) ??
  mongoose.model<SegmentDoc>('Segment', schema, 'segments');
