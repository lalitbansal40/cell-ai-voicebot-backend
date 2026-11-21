import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { META_CALL_DIAG } from '../../config/limits';
import { basePlugin } from '../plugins/base';

export const META_CALL_ERROR_VIAS = ['meta', 'meta_direct', 'pinnacle'] as const;
export type MetaCallErrorVia = (typeof META_CALL_ERROR_VIAS)[number];

export interface MetaCallErrorDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  channelId: Types.ObjectId;
  callId: Types.ObjectId | null;
  op: string;
  metaCode: number | null;
  metaSubcode: number | null;
  type: string | null;
  message: string;
  fbtraceId: string | null;
  httpStatus: number | null;
  via: MetaCallErrorVia;
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<MetaCallErrorDoc>({
  accountId: { type: Schema.Types.ObjectId, required: true },
  channelId: { type: Schema.Types.ObjectId, required: true },
  callId: { type: Schema.Types.ObjectId, default: null },
  op: { type: String, required: true, maxlength: 40 },
  metaCode: { type: Number, default: null },
  metaSubcode: { type: Number, default: null },
  type: { type: String, default: null, maxlength: 80 },
  message: { type: String, required: true, maxlength: 300 },
  fbtraceId: { type: String, default: null, maxlength: 100 },
  httpStatus: { type: Number, default: null },
  via: { type: String, enum: META_CALL_ERROR_VIAS, required: true },
  at: { type: Date, required: true, default: Date.now },
});
schema.plugin(basePlugin);
schema.index({ at: 1 }, { expireAfterSeconds: META_CALL_DIAG.errorTtlDays * 86_400 });
schema.index({ channelId: 1, at: -1 });
schema.index({ accountId: 1, at: -1 });

/** Short-lived, customer-data-minimized Meta calling diagnostics. */
export const MetaCallErrorModel: Model<MetaCallErrorDoc> =
  (mongoose.models.MetaCallError as Model<MetaCallErrorDoc> | undefined) ??
  mongoose.model<MetaCallErrorDoc>('MetaCallError', schema, 'metaCallErrors');
