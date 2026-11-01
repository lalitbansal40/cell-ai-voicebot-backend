import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const SUPPRESSION_REASONS = ['erased', 'opted_out', 'dnd'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressionDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** HMAC-SHA256 of the E.164 phone with `SUPPRESSION_HMAC_KEY`; the number itself isn't kept. */
  phoneHmac: string;
  reason: SuppressionReason;
  at: Date;
}

const schema = new Schema<SuppressionDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    phoneHmac: { type: String, required: true },
    reason: { type: String, enum: SUPPRESSION_REASONS, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);
schema.index({ accountId: 1, phoneHmac: 1 }, { unique: true });

/** People who must not come back (`suppressions`, ADR 0048). */
export const SuppressionModel: Model<SuppressionDoc> =
  (mongoose.models.Suppression as Model<SuppressionDoc> | undefined) ??
  mongoose.model<SuppressionDoc>('Suppression', schema, 'suppressions');
