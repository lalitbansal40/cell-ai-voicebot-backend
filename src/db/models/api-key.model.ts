import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export interface ApiKeyDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  /** First characters of the key, shown in the UI (`cav_live_ab12`). */
  prefix: string;
  /** SHA-256 hex of the full key — the raw key is shown once. */
  keyHash: string;
  scopes: string[];
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  /** Client IPs / CIDR ranges allowed to use the key (empty = any; ≤ 20). */
  ipAllowlist: string[];
  /** The key stops working at this time (null = never). */
  expiresAt?: Date | null;
  /** Requests per day, the last 7 days (`day` = YYYY-MM-DD UTC). */
  usage: ApiKeyUsageDay[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyUsageDay {
  day: string;
  reads: number;
  writes: number;
}

const schema = new Schema<ApiKeyDoc>({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  prefix: { type: String, required: true },
  keyHash: { type: String, required: true },
  scopes: { type: [String], default: [] },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  ipAllowlist: { type: [String], default: [] },
  expiresAt: { type: Date, default: null },
  usage: {
    type: [{ _id: false, day: String, reads: Number, writes: Number }],
    default: [],
  },
  createdBy: { type: Schema.Types.ObjectId, required: true },
});
schema.plugin(basePlugin, { hide: ['keyHash'] });
schema.plugin(tenantPlugin);
schema.index({ keyHash: 1 }, { unique: true });
schema.index({ accountId: 1, revokedAt: 1 });

/** Public-API keys (data-model.md §2.1). */
export const ApiKeyModel: Model<ApiKeyDoc> =
  (mongoose.models.ApiKey as Model<ApiKeyDoc> | undefined) ??
  mongoose.model<ApiKeyDoc>('ApiKey', schema, 'apiKeys');
