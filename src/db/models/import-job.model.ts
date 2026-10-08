import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const IMPORT_KINDS = ['contacts', 'dnd'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_FILE_TYPES = ['csv', 'xlsx'] as const;
export type ImportFileType = (typeof IMPORT_FILE_TYPES)[number];

export const IMPORT_STATUSES = [
  'uploaded',
  'mapped',
  'validating',
  'validated',
  'importing',
  'completed',
  'failed',
  'canceled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ImportColumn {
  index: number;
  header: string;
  /** First non-empty values (shown on the mapping screen; PII, purged with the file). */
  samples: string[];
}

export interface ImportTotals {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  duplicates: number;
  dnd: number;
}

export interface ImportProblemRow {
  row: number;
  reasons: string[];
}

export interface ImportJobDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  kind: ImportKind;
  fileName: string;
  fileKey?: string | null;
  fileType: ImportFileType;
  fileSize: number;
  sheet?: string | null;
  sheets: string[];
  columns: ImportColumn[];
  rowCount: number;
  /** Validated by the contact-imports module (`ImportMapping`). */
  mapping?: Record<string, unknown> | null;
  options?: Record<string, unknown> | null;
  status: ImportStatus;
  progress: { processed: number; total: number };
  totals: ImportTotals;
  problemRows: ImportProblemRow[];
  errorReportKey?: string | null;
  listId?: Types.ObjectId | null;
  warnings: string[];
  errorMessage?: string | null;
  cancelRequested: boolean;
  createdBy: Types.ObjectId;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  canceledAt?: Date | null;
  filesPurgedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const emptyImportTotals = (): ImportTotals => ({
  rows: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  invalid: 0,
  duplicates: 0,
  dnd: 0,
});

const schema = new Schema<ImportJobDoc>({
  kind: { type: String, enum: IMPORT_KINDS, required: true },
  fileName: { type: String, required: true, maxlength: 255 },
  fileKey: { type: String, default: null },
  fileType: { type: String, enum: IMPORT_FILE_TYPES, required: true },
  fileSize: { type: Number, required: true },
  sheet: { type: String, default: null },
  sheets: { type: [String], default: [] },
  columns: {
    type: [
      new Schema(
        { index: Number, header: String, samples: { type: [String], default: [] } },
        { _id: false },
      ),
    ],
    default: [],
  },
  rowCount: { type: Number, default: 0 },
  mapping: { type: Schema.Types.Mixed, default: null },
  options: { type: Schema.Types.Mixed, default: null },
  status: { type: String, enum: IMPORT_STATUSES, default: 'uploaded' },
  progress: {
    processed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  totals: { type: Schema.Types.Mixed, default: emptyImportTotals },
  problemRows: {
    type: [new Schema({ row: Number, reasons: [String] }, { _id: false })],
    default: [],
  },
  errorReportKey: { type: String, default: null },
  listId: { type: Schema.Types.ObjectId, default: null },
  warnings: { type: [String], default: [] },
  errorMessage: { type: String, default: null },
  cancelRequested: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  canceledAt: { type: Date, default: null },
  filesPurgedAt: { type: Date, default: null },
});
schema.plugin(basePlugin, { hide: ['fileKey', 'errorReportKey', 'cancelRequested'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ status: 1, completedAt: 1 });

/** Contact / DND file imports (data-model.md §2.2). File + report purged after 30 days. */
export const ImportJobModel: Model<ImportJobDoc> =
  (mongoose.models.ImportJob as Model<ImportJobDoc> | undefined) ??
  mongoose.model<ImportJobDoc>('ImportJob', schema, 'importJobs');
