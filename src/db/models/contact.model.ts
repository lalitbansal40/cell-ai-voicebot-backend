import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

export const CONTACT_SOURCE_TYPES = ['manual', 'import', 'api'] as const;
export type ContactSourceType = (typeof CONTACT_SOURCE_TYPES)[number];

/** Stored variable value: text / date (`YYYY-MM-DD`) / phone as string, number / currency (micros) as number. */
export type VariableValue = string | number;

export interface ContactDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  phoneE164: string;
  name?: string | null;
  email?: string | null;
  /** Client's own id (loan / CRM id), unique per account when set. */
  externalId?: string | null;
  variables: Map<string, VariableValue>;
  tags: string[];
  listIds: Types.ObjectId[];
  /** Mirrors `dndEntries` for fast filtering. */
  dnd: boolean;
  optedOutAt?: Date | null;
  consent?: { source: string; at: Date } | null;
  source: { type: ContactSourceType; importJobId?: Types.ObjectId | null };
  /** Lower-case name + email + phone digits + externalId (search only, never serialised). */
  searchText: string;
  lastCalledAt?: Date | null;
  callCount: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ContactDoc>({
  phoneE164: { type: String, required: true },
  name: { type: String, default: null, trim: true, maxlength: 120 },
  email: { type: String, default: null, lowercase: true, trim: true, maxlength: 254 },
  externalId: { type: String, default: null, trim: true, maxlength: 100 },
  variables: { type: Map, of: Schema.Types.Mixed, default: () => new Map() },
  tags: { type: [String], default: [] },
  listIds: { type: [Schema.Types.ObjectId], default: [] },
  dnd: { type: Boolean, default: false },
  optedOutAt: { type: Date, default: null },
  consent: {
    type: new Schema(
      { source: { type: String, required: true }, at: { type: Date, required: true } },
      { _id: false },
    ),
    default: null,
  },
  source: {
    type: new Schema(
      {
        type: { type: String, enum: CONTACT_SOURCE_TYPES, required: true },
        importJobId: { type: Schema.Types.ObjectId, default: null },
      },
      { _id: false },
    ),
    required: true,
  },
  searchText: { type: String, default: '' },
  lastCalledAt: { type: Date, default: null },
  callCount: { type: Number, default: 0 },
});
schema.plugin(basePlugin, { hide: ['searchText', 'deletedAt'] });
schema.plugin(tenantPlugin);
schema.plugin(softDeletePlugin);
schema.index(
  { accountId: 1, phoneE164: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
schema.index(
  { accountId: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' }, deletedAt: null } },
);
schema.index({ accountId: 1, deletedAt: 1, createdAt: -1 });
schema.index({ accountId: 1, listIds: 1 });
schema.index({ accountId: 1, tags: 1 });
schema.index({ accountId: 1, dnd: 1 });
schema.index({ accountId: 1, name: 1 }, { collation: { locale: 'en', strength: 2 } });

/** Contacts (data-model.md §2.2). PII: phone, name, email, variables. */
export const ContactModel: Model<ContactDoc> =
  (mongoose.models.Contact as Model<ContactDoc> | undefined) ??
  mongoose.model<ContactDoc>('Contact', schema, 'contacts');
