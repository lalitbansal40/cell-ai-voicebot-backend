import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const EXPORT_STATUSES = ['pending', 'processing', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_SCOPES = ['ids', 'filter', 'list', 'segment'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export interface ExportJobDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  scope: ExportScope;
  /** Resolved `ContactFilter` (ids / list / segment turned into a filter at creation). */
  filter: Record<string, unknown>;
  columns: string[];
  status: ExportStatus;
  progress: { processed: number; total: number };
  rowCount: number;
  fileKey?: string | null;
  errorMessage?: string | null;
  createdBy: Types.ObjectId;
  completedAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ExportJobDoc>({
  scope: { type: String, enum: EXPORT_SCOPES, required: true },
  filter: { type: Schema.Types.Mixed, default: () => ({}) },
  columns: { type: [String], default: [] },
  status: { type: String, enum: EXPORT_STATUSES, default: 'pending' },
  progress: {
    processed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  rowCount: { type: Number, default: 0 },
  fileKey: { type: String, default: null },
  errorMessage: { type: String, default: null },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
});
schema.plugin(basePlugin, { hide: ['fileKey'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ status: 1, expiresAt: 1 });

/** Contact CSV exports (data-model.md §2.2). Files deleted after 24 h. */
export const ExportJobModel: Model<ExportJobDoc> =
  (mongoose.models.ExportJob as Model<ExportJobDoc> | undefined) ??
  mongoose.model<ExportJobDoc>('ExportJob', schema, 'exportJobs');
