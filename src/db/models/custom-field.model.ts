import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const FIELD_TYPES = ['text', 'number', 'date', 'currency', 'phone'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface CustomFieldDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** `{{key}}` in flows; immutable. */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Stored form (currency in micros, date `YYYY-MM-DD`). */
  defaultValue?: string | number | null;
  order: number;
  /** Values are stored sealed as `{ $enc }` (ADR 0047). */
  sensitive: boolean;
  /** Progress of sealing / opening the existing values. */
  sensitiveJob?: { status: 'running' | 'done' | 'failed'; done: number; total: number } | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<CustomFieldDoc>({
  key: { type: String, required: true, match: /^[a-z][a-z0-9_]{0,39}$/ },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  type: { type: String, enum: FIELD_TYPES, required: true },
  required: { type: Boolean, default: false },
  defaultValue: { type: Schema.Types.Mixed, default: null },
  order: { type: Number, default: 0 },
  sensitive: { type: Boolean, default: false },
  sensitiveJob: { type: Schema.Types.Mixed, default: null },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, key: 1 }, { unique: true });
schema.index({ accountId: 1, order: 1 });

/** Custom field definitions (`customFieldDefinitions`, data-model.md §2.2). */
export const CustomFieldModel: Model<CustomFieldDoc> =
  (mongoose.models.CustomField as Model<CustomFieldDoc> | undefined) ??
  mongoose.model<CustomFieldDoc>('CustomField', schema, 'customFieldDefinitions');
