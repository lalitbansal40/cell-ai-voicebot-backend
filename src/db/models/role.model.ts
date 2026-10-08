import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export interface RoleDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** System key (`owner` … `viewer`) or a custom key later. */
  key: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<RoleDoc>({
  key: { type: String, required: true, trim: true, maxlength: 40 },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  permissions: { type: [String], default: [] },
  isSystem: { type: Boolean, default: false },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, key: 1 }, { unique: true });

/** Account role → permissions (data-model.md §2.1). */
export const RoleModel: Model<RoleDoc> =
  (mongoose.models.Role as Model<RoleDoc> | undefined) ??
  mongoose.model<RoleDoc>('Role', schema, 'roles');
