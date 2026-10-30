import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const SHEET_SCHEDULES = ['once', 'hourly', 'daily'] as const;
export type SheetSchedule = (typeof SHEET_SCHEDULES)[number];
export const SHEET_RUN_STATUSES = ['ok', 'failed', 'busy', 'running'] as const;
export type SheetRunStatus = (typeof SHEET_RUN_STATUSES)[number];

export interface SheetImportDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  /** A Google Sheet published to the web as CSV (never logged — it is a secret link). */
  url: string;
  schedule: SheetSchedule;
  /** Column → field mapping of the contact import (existing fields only). */
  mapping: { columns: { index: number; target: string; key?: string; dateFormat?: string }[] };
  /** Contacts are added to this list (created with the import). */
  listId: Types.ObjectId;
  updateExisting: boolean;
  tags: string[];
  active: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastStatus: SheetRunStatus | null;
  lastError: string | null;
  lastResult: {
    importJobId: Types.ObjectId | null;
    rows: number;
    created: number;
    updated: number;
    failed: number;
  } | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<SheetImportDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, maxlength: 2048, select: false },
    schedule: { type: String, enum: SHEET_SCHEDULES, required: true },
    mapping: { type: Schema.Types.Mixed, required: true },
    listId: { type: Schema.Types.ObjectId, required: true },
    updateExisting: { type: Boolean, default: true },
    tags: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastStatus: { type: String, enum: [...SHEET_RUN_STATUSES, null], default: null },
    lastError: { type: String, default: null, maxlength: 200 },
    lastResult: { type: Schema.Types.Mixed, default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['url'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ active: 1, nextRunAt: 1 });

/** Scheduled Google-Sheet contact imports (Phase 15, PHASE_15_PLAN §1e; ≤ 5 per account). */
export const SheetImportModel: Model<SheetImportDoc> =
  (mongoose.models.SheetImport as Model<SheetImportDoc> | undefined) ??
  mongoose.model<SheetImportDoc>('SheetImport', schema, 'sheetImports');
