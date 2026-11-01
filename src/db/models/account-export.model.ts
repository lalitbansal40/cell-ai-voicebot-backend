import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const ACCOUNT_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type AccountExportStatus = (typeof ACCOUNT_EXPORT_STATUSES)[number];

export interface AccountExportDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  status: AccountExportStatus;
  includeRecordings: boolean;
  fileKey: string | null;
  sizeBytes: number | null;
  /** Records per store (counts only). */
  counts: Record<string, number>;
  error: string | null;
  /** The file is deleted after this (7 days). */
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<AccountExportDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    requestedBy: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ACCOUNT_EXPORT_STATUSES, default: 'queued' },
    includeRecordings: { type: Boolean, default: false },
    fileKey: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    counts: { type: Schema.Types.Mixed, default: () => ({}) },
    error: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ status: 1, expiresAt: 1 });

/** Whole-account archives (`accountExports`). */
export const AccountExportModel: Model<AccountExportDoc> =
  (mongoose.models.AccountExport as Model<AccountExportDoc> | undefined) ??
  mongoose.model<AccountExportDoc>('AccountExport', schema, 'accountExports');
