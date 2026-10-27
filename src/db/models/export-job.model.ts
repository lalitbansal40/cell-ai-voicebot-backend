import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const EXPORT_STATUSES = ['pending', 'processing', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_SCOPES = ['ids', 'filter', 'list', 'segment'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];
/** Stored scopes: the contact export scopes + `campaign` (campaign results, Phase 8) + `records` (Phase 14). */
export const EXPORT_JOB_SCOPES = [...EXPORT_SCOPES, 'campaign', 'records'] as const;
export type ExportJobScope = (typeof EXPORT_JOB_SCOPES)[number];

/** Phase 14: `calls`, `messages` (metadata only) and `report` (a report tab's numbers). */
export const EXPORT_KINDS = [
  'contacts',
  'campaign_results',
  'calls',
  'messages',
  'report',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportJobDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** `contacts` (Phase 3) or `campaign_results` (Phase 8). */
  kind: ExportKind;
  /** Campaign of a `campaign_results` export. */
  campaignId: Types.ObjectId | null;
  format: ExportFormat;
  /** Full phone numbers (the creator had `contacts.export`); else last 4 digits. */
  includePhone: boolean;
  /** Phase 14 calls export: the AI summaries column. */
  includeSummary?: boolean;
  scope: ExportJobScope;
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

const schema = new Schema<ExportJobDoc>(
  {
    kind: { type: String, enum: EXPORT_KINDS, default: 'contacts' },
    campaignId: { type: Schema.Types.ObjectId, default: null },
    format: { type: String, enum: EXPORT_FORMATS, default: 'csv' },
    includePhone: { type: Boolean, default: true },
    includeSummary: { type: Boolean, default: false },
    scope: { type: String, enum: EXPORT_JOB_SCOPES, required: true },
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
  },
  // Keep an empty selection (`{ filter: {} }` = every contact) — don't drop empty objects.
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['fileKey'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ status: 1, expiresAt: 1 });

/** Contact CSV exports (data-model.md §2.2), campaign results (§2.5) and records / reports (§2.11). Files deleted after 24 h. */
export const ExportJobModel: Model<ExportJobDoc> =
  (mongoose.models.ExportJob as Model<ExportJobDoc> | undefined) ??
  mongoose.model<ExportJobDoc>('ExportJob', schema, 'exportJobs');
