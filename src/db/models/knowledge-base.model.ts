import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const KNOWLEDGE_BASE_STATUSES = ['ok', 'stale'] as const;
export type KnowledgeBaseStatus = (typeof KNOWLEDGE_BASE_STATUSES)[number];

export interface KnowledgeBaseDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  description: string | null;
  /** Bumped on every source change / re-index — vector caches key on it. */
  version: number;
  sourcesCount: number;
  chunksCount: number;
  embeddingModel: string | null;
  status: KnowledgeBaseStatus;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<KnowledgeBaseDoc>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: null, maxlength: 300 },
  version: { type: Number, default: 0, min: 0 },
  sourcesCount: { type: Number, default: 0, min: 0 },
  chunksCount: { type: Number, default: 0, min: 0 },
  embeddingModel: { type: String, default: null },
  status: { type: String, enum: KNOWLEDGE_BASE_STATUSES, default: 'ok' },
  createdBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

/** Account-level knowledge bases agents can search (data-model.md §2.4). */
export const KnowledgeBaseModel: Model<KnowledgeBaseDoc> =
  (mongoose.models.KnowledgeBase as Model<KnowledgeBaseDoc> | undefined) ??
  mongoose.model<KnowledgeBaseDoc>('KnowledgeBase', schema, 'knowledgeBases');
