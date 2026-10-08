import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export type IdempotencyStatus = 'in_progress' | 'completed';

export interface IdempotencyKeyDoc {
  accountId: Types.ObjectId;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus?: number;
  responseBody?: unknown;
  expiresAt: Date;
}

const schema = new Schema<IdempotencyKeyDoc>({
  accountId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true, maxlength: 255 },
  method: { type: String, required: true },
  path: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: { type: String, enum: ['in_progress', 'completed'], required: true },
  responseStatus: { type: Number },
  responseBody: { type: Schema.Types.Mixed },
  expiresAt: { type: Date, required: true },
});
schema.plugin(basePlugin);
schema.index({ accountId: 1, key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Stored Idempotency-Key requests (docs/conventions/data-model.md, api.md §10). TTL 24 h. */
export const IdempotencyKeyModel: Model<IdempotencyKeyDoc> =
  (mongoose.models.IdempotencyKey as Model<IdempotencyKeyDoc> | undefined) ??
  mongoose.model<IdempotencyKeyDoc>('IdempotencyKey', schema, 'idempotencyKeys');
