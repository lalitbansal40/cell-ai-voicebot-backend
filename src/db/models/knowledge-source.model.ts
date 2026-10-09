import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const KNOWLEDGE_SOURCE_STATUSES = [
  'queued',
  'processing',
  'ready',
  'failed',
  'stale',
] as const;
export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number];

export const KNOWLEDGE_SOURCE_KINDS = ['file', 'url'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_FILE_TYPES = ['pdf', 'docx', 'txt', 'md'] as const;
export type KnowledgeFileType = (typeof KNOWLEDGE_FILE_TYPES)[number];

export interface KnowledgeSourceDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  kbId: Types.ObjectId;
  kind: KnowledgeSourceKind;
  title: string;
  fileType: KnowledgeFileType | null;
  fileKey: string | null;
  url: string | null;
  bytes: number;
  chars: number;
  chunks: number;
  status: KnowledgeSourceStatus;
  progress: number;
  error: string | null;
  /** Chunks of the current version are the live ones (a crash never mixes versions). */
  version: number;
  embeddingModel: string | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<KnowledgeSourceDoc>({
  kbId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: KNOWLEDGE_SOURCE_KINDS, required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  fileType: { type: String, enum: [...KNOWLEDGE_FILE_TYPES, null], default: null },
  fileKey: { type: String, default: null },
  url: { type: String, default: null, maxlength: 2000 },
  bytes: { type: Number, default: 0, min: 0 },
  chars: { type: Number, default: 0, min: 0 },
  chunks: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: KNOWLEDGE_SOURCE_STATUSES, default: 'queued' },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  error: { type: String, default: null, maxlength: 300 },
  version: { type: Number, default: 0, min: 0 },
  embeddingModel: { type: String, default: null },
  createdBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin, { hide: ['fileKey'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, kbId: 1, createdAt: -1 });

/** A file or URL inside a knowledge base. */
export const KnowledgeSourceModel: Model<KnowledgeSourceDoc> =
  (mongoose.models.KnowledgeSource as Model<KnowledgeSourceDoc> | undefined) ??
  mongoose.model<KnowledgeSourceDoc>('KnowledgeSource', schema, 'knowledgeSources');
