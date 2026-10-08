import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export const REVOKE_REASONS = [
  'logout',
  'logout_all',
  'rotated',
  'reuse_detected',
  'password_changed',
  'disabled',
  'removed',
  'session_revoked',
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export interface RefreshTokenDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  accountId: Types.ObjectId;
  /** Rotation family = one login session. */
  familyId: string;
  /** HMAC of the opaque token — never the raw value. */
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: RevokeReason | null;
  replacedBy?: Types.ObjectId | null;
  userAgent?: string | null;
  ip?: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<RefreshTokenDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  familyId: { type: String, required: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  revokedReason: { type: String, enum: [...REVOKE_REASONS, null], default: null },
  replacedBy: { type: Schema.Types.ObjectId, default: null },
  userAgent: { type: String, default: null, maxlength: 300 },
  ip: { type: String, default: null, maxlength: 64 },
  lastUsedAt: { type: Date, required: true, default: () => new Date() },
});
schema.plugin(basePlugin);
schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ userId: 1, familyId: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Rotating refresh tokens (ADR 0009, data-model.md §2.1). */
export const RefreshTokenModel: Model<RefreshTokenDoc> =
  (mongoose.models.RefreshToken as Model<RefreshTokenDoc> | undefined) ??
  mongoose.model<RefreshTokenDoc>('RefreshToken', schema, 'refreshTokens');
