import { Schema, type Types } from 'mongoose';

export interface TenantDoc {
  accountId: Types.ObjectId;
}

/** Every tenant document carries an indexed `accountId` (data.md §2). */
export const tenantPlugin = (schema: Schema): void => {
  schema.add({ accountId: { type: Schema.Types.ObjectId, required: true, index: true } });
};
