import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

export const LIST_SOURCE_TYPES = ['upload', 'api', 'manual'] as const;
export type ListSourceType = (typeof LIST_SOURCE_TYPES)[number];

export interface ContactListDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  description?: string | null;
  source: { type: ListSourceType; fileName?: string | null };
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ContactListDoc>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: null, trim: true, maxlength: 500 },
  source: {
    type: new Schema(
      {
        type: { type: String, enum: LIST_SOURCE_TYPES, required: true },
        fileName: { type: String, default: null },
      },
      { _id: false },
    ),
    required: true,
  },
});
schema.plugin(basePlugin, { hide: ['deletedAt'] });
schema.plugin(tenantPlugin);
schema.plugin(softDeletePlugin);
schema.index(
  { accountId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    collation: { locale: 'en', strength: 2 },
  },
);

/** Contact lists — counts are computed on read (data-model.md §2.2). */
export const ContactListModel: Model<ContactListDoc> =
  (mongoose.models.ContactList as Model<ContactListDoc> | undefined) ??
  mongoose.model<ContactListDoc>('ContactList', schema, 'contactLists');
