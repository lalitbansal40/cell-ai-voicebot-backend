import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { PUBLIC_API_LIMITS } from '../../config/limits';

export interface ApiRequestLogDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  apiKeyId: Types.ObjectId;
  method: string;
  /** Route template (`/api/v1/calls/:id`) — never ids, query values or bodies. */
  route: string;
  status: number;
  ms: number;
  requestId: string;
  at: Date;
}

const schema = new Schema<ApiRequestLogDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    apiKeyId: { type: Schema.Types.ObjectId, required: true },
    method: { type: String, required: true },
    route: { type: String, required: true, maxlength: 200 },
    status: { type: Number, required: true },
    ms: { type: Number, required: true },
    requestId: { type: String, default: '' },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);
schema.index({ accountId: 1, apiKeyId: 1, at: -1, _id: -1 });
schema.index({ at: 1 }, { expireAfterSeconds: PUBLIC_API_LIMITS.requestLogTtlDays * 86_400 });

/** One row per public-API request (Phase 15, TTL 7 days; data-model.md). */
export const ApiRequestLogModel: Model<ApiRequestLogDoc> =
  (mongoose.models.ApiRequestLog as Model<ApiRequestLogDoc> | undefined) ??
  mongoose.model<ApiRequestLogDoc>('ApiRequestLog', schema, 'apiRequestLogs');
