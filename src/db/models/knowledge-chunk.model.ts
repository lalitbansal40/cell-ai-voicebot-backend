import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { AI_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export interface KnowledgeChunkDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  kbId: Types.ObjectId;
  sourceId: Types.ObjectId;
  sourceVersion: number;
  order: number;
  title: string;
  text: string;
  /** Unit-length embedding (cosine = dot product). */
  embedding: number[];
  dims: number;
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<KnowledgeChunkDoc>({
  kbId: { type: Schema.Types.ObjectId, required: true },
  sourceId: { type: Schema.Types.ObjectId, required: true },
  sourceVersion: { type: Number, required: true, min: 0 },
  order: { type: Number, required: true, min: 0 },
  title: { type: String, default: '', maxlength: 200 },
  text: { type: String, required: true, maxlength: AI_LIMITS.chunkMaxChars },
  embedding: { type: [Number], required: true },
  dims: { type: Number, required: true, min: 1 },
  model: { type: String, required: true },
});
schema.plugin(basePlugin, { hide: ['embedding'] });
schema.plugin(tenantPlugin);
schema.index({ kbId: 1, sourceId: 1, sourceVersion: 1, order: 1 });
schema.index({ accountId: 1, kbId: 1 });

/** Text pieces of a knowledge source with their embeddings. */
export const KnowledgeChunkModel: Model<KnowledgeChunkDoc> =
  (mongoose.models.KnowledgeChunk as Model<KnowledgeChunkDoc> | undefined) ??
  mongoose.model<KnowledgeChunkDoc>('KnowledgeChunk', schema, 'knowledgeChunks');
