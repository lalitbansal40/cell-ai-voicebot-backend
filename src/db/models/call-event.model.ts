import mongoose, { Schema, type Model, type Query, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const CALL_EVENT_TYPES = [
  'status',
  'node_entered',
  'node_exited',
  'dtmf',
  'speech_started',
  'barge_in',
  'silence_prompt',
  'ai_session_started',
  'ai_session_ended',
  'ai_function_call',
  'ai_function_result',
  'ai_outcome',
  'tts',
  'latency',
  'wallet_extend',
  'transfer',
  'recording_saved',
  'recording_failed',
  'error',
] as const;
export type CallEventType = (typeof CALL_EVENT_TYPES)[number];

export interface CallEventDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  callId: Types.ObjectId;
  seq: number;
  type: CallEventType;
  /** Never texts, digits, phones or secrets — ids, names, counts, durations, codes. */
  data: Record<string, unknown>;
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class CallEventImmutableError extends Error {
  constructor() {
    super('Call events are immutable');
    this.name = 'CallEventImmutableError';
  }
}

const schema = new Schema<CallEventDoc>(
  {
    callId: { type: Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true, min: 1 },
    type: { type: String, enum: CALL_EVENT_TYPES, required: true },
    data: { type: Schema.Types.Mixed, default: () => ({}) },
    at: { type: Date, required: true },
  },
  { minimize: false },
);
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ callId: 1, seq: 1 }, { unique: true });
schema.index({ accountId: 1, at: -1 });

// The timeline is append-only: inserts and deletes (purge) only.
const refuse = function (this: Query<unknown, unknown>) {
  throw new CallEventImmutableError();
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
] as const) {
  schema.pre(op, refuse);
}
schema.pre('save', function () {
  if (!this.isNew) throw new CallEventImmutableError();
});

/** Call timeline (data-model.md CallEvent — immutable). */
export const CallEventModel: Model<CallEventDoc> =
  (mongoose.models.CallEvent as Model<CallEventDoc> | undefined) ??
  mongoose.model<CallEventDoc>('CallEvent', schema, 'callEvents');
