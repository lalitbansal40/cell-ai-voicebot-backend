import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export const META_DELETION_STATUSES = ['received', 'completed'] as const;
export type MetaDeletionStatus = (typeof META_DELETION_STATUSES)[number];

export interface MetaDeletionRequestDoc {
  _id: Types.ObjectId;
  confirmationCode: string;
  metaUserId: string;
  status: MetaDeletionStatus;
  channelsAffected: number;
  receivedAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<MetaDeletionRequestDoc>({
  confirmationCode: { type: String, required: true, maxlength: 32 },
  metaUserId: { type: String, required: true, maxlength: 64 },
  status: { type: String, enum: META_DELETION_STATUSES, default: 'received', required: true },
  channelsAffected: { type: Number, default: 0 },
  receivedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin);
schema.index({ confirmationCode: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Meta "data deletion" callbacks and their status (PHASE_9_PLAN §1i). System collection. */
export const MetaDeletionRequestModel: Model<MetaDeletionRequestDoc> =
  (mongoose.models.MetaDeletionRequest as Model<MetaDeletionRequestDoc> | undefined) ??
  mongoose.model<MetaDeletionRequestDoc>('MetaDeletionRequest', schema, 'metaDeletionRequests');
