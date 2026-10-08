import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export type AuthCodePurpose = 'verify_email' | 'reset_password';

export interface AuthCodeDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: AuthCodePurpose;
  codeHash: string;
  attempts: number;
  /** Sends in the current hour window (cap: OTP_MAX_SENDS_PER_HOUR). */
  sentCount: number;
  sendWindowStart: Date;
  lastSentAt: Date;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<AuthCodeDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  purpose: { type: String, enum: ['verify_email', 'reset_password'], required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  sentCount: { type: Number, default: 1 },
  sendWindowStart: { type: Date, required: true, default: () => new Date() },
  lastSentAt: { type: Date, required: true, default: () => new Date() },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
});
schema.plugin(basePlugin);
schema.index({ userId: 1, purpose: 1 }, { unique: true });
schema.index({ codeHash: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** One-time email OTPs and reset tokens (hashed). One live code per user + purpose. */
export const AuthCodeModel: Model<AuthCodeDoc> =
  (mongoose.models.AuthCode as Model<AuthCodeDoc> | undefined) ??
  mongoose.model<AuthCodeDoc>('AuthCode', schema, 'authCodes');
