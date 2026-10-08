import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

export type UserStatus = 'invited' | 'active' | 'disabled';
export type PlatformRole = 'superadmin';

export interface UserInvite {
  tokenHash: string;
  expiresAt: Date;
  invitedBy: Types.ObjectId;
  lastSentAt: Date;
}

export interface UserDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  email: string;
  phone?: string | null;
  passwordHash?: string | null;
  roleId: Types.ObjectId;
  status: UserStatus;
  emailVerifiedAt?: Date | null;
  /** Bumped to invalidate every access token of the user at once. */
  tokenVersion: number;
  platformRole?: PlatformRole | null;
  invite?: UserInvite | null;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields that must never leave the server. */
export const USER_SECRET_FIELDS = ['passwordHash', 'tokenVersion', 'invite'] as const;

const schema = new Schema<UserDoc>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  phone: { type: String, default: null },
  passwordHash: { type: String, default: null },
  roleId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['invited', 'active', 'disabled'], required: true },
  emailVerifiedAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 0, required: true },
  platformRole: { type: String, enum: ['superadmin', null], default: null },
  invite: {
    type: new Schema<UserInvite>(
      {
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        invitedBy: { type: Schema.Types.ObjectId, required: true },
        lastSentAt: { type: Date, required: true },
      },
      { _id: false },
    ),
    default: null,
  },
  lastLoginAt: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
});
schema.plugin(basePlugin, { hide: USER_SECRET_FIELDS });
schema.plugin(tenantPlugin);
schema.plugin(softDeletePlugin);

// Email is unique across the platform, except for removed (soft-deleted) users.
schema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
schema.index({ accountId: 1, status: 1 });
schema.index({ 'invite.tokenHash': 1 }, { sparse: true });

/** Team member / superadmin (data-model.md §2.1). Tenant-scoped, soft delete. */
export const UserModel: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc> | undefined) ??
  mongoose.model<UserDoc>('User', schema, 'users');
