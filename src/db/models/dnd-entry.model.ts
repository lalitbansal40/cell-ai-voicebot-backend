import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const DND_SOURCES = ['manual', 'upload', 'keyword', 'dtmf'] as const;
export type DndSource = (typeof DND_SOURCES)[number];

export interface DndEntryDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  phoneE164: string;
  reason?: string | null;
  source: DndSource;
  addedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<DndEntryDoc>({
  phoneE164: { type: String, required: true },
  reason: { type: String, default: null, trim: true, maxlength: 200 },
  source: { type: String, enum: DND_SOURCES, required: true },
  addedBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, phoneE164: 1 }, { unique: true });
schema.index({ accountId: 1, createdAt: -1 });

/** Do-not-call list per account (data-model.md §2.2). PII: phone. */
export const DndEntryModel: Model<DndEntryDoc> =
  (mongoose.models.DndEntry as Model<DndEntryDoc> | undefined) ??
  mongoose.model<DndEntryDoc>('DndEntry', schema, 'dndEntries');
