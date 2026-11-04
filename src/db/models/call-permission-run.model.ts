import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const CALL_PERMISSION_RUN_STATUSES = ['queued', 'running', 'done', 'stopped'] as const;
export type CallPermissionRunStatus = (typeof CALL_PERMISSION_RUN_STATUSES)[number];

/** Why a contact was not asked (fixed set, PHASE_18B_PROMPT §1). */
export const CALL_PERMISSION_SKIP_REASONS = [
  'dnd',
  'opted_out',
  'suppressed',
  'no_whatsapp',
  'already_allowed',
  'meta_limit',
  'declined_recently',
  'wallet_empty',
] as const;
export type CallPermissionSkipReason = (typeof CALL_PERMISSION_SKIP_REASONS)[number];

export type CallPermissionRunTarget =
  | { type: 'contacts'; count: number }
  | { type: 'list'; id: Types.ObjectId }
  | { type: 'segment'; id: Types.ObjectId };

export interface CallPermissionRunDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  templateId: Types.ObjectId;
  /** Values for the template's variables (the same for every contact). */
  variables: Record<string, string>;
  target: CallPermissionRunTarget;
  /** Resolved once at start (≤ 5,000): ids only. */
  contactIds: Types.ObjectId[];
  /** Contacts handled so far (a retried job resumes here). */
  cursor: number;
  status: CallPermissionRunStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: Partial<Record<CallPermissionSkipReason, number>>;
  createdBy: Types.ObjectId;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<CallPermissionRunDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    channelId: { type: Schema.Types.ObjectId, required: true },
    templateId: { type: Schema.Types.ObjectId, required: true },
    variables: { type: Schema.Types.Mixed, default: () => ({}) },
    target: { type: Schema.Types.Mixed, required: true },
    contactIds: { type: [Schema.Types.ObjectId], default: [] },
    cursor: { type: Number, default: 0 },
    status: { type: String, enum: CALL_PERMISSION_RUN_STATUSES, default: 'queued' },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
schema.index({ accountId: 1, createdAt: -1 });

/** Phase 18B bulk call permission requests (`callPermissionRuns`): ids and counters only. */
export const CallPermissionRunModel: Model<CallPermissionRunDoc> =
  (mongoose.models.CallPermissionRun as Model<CallPermissionRunDoc> | undefined) ??
  mongoose.model<CallPermissionRunDoc>('CallPermissionRun', schema, 'callPermissionRuns');
