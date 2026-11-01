import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const ERASE_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type EraseJobStatus = (typeof ERASE_JOB_STATUSES)[number];

export interface EraseJobDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  status: EraseJobStatus;
  contactIds: Types.ObjectId[];
  total: number;
  done: number;
  /** Contacts on a live call: tried again later. */
  retried: number;
  counts: Record<string, number>;
  /** Removed after this (90 days). */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<EraseJobDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    requestedBy: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ERASE_JOB_STATUSES, default: 'queued' },
    contactIds: { type: [Schema.Types.ObjectId], default: [] },
    total: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    retried: { type: Number, default: 0 },
    counts: { type: Schema.Types.Mixed, default: () => ({}) },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
schema.index({ accountId: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Bulk erase progress (`eraseJobs`): ids and counts only. */
export const EraseJobModel: Model<EraseJobDoc> =
  (mongoose.models.EraseJob as Model<EraseJobDoc> | undefined) ??
  mongoose.model<EraseJobDoc>('EraseJob', schema, 'eraseJobs');
