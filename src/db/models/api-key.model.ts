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
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ApiKeyDoc>({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  prefix: { type: String, required: true },
  keyHash: { type: String, required: true },
  scopes: { type: [String], default: [] },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
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
