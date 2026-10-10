import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

export const AUDIO_FORMATS = ['wav', 'mp3'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export interface FlowAudioDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  /** `accounts/<accountId>/flow-audio/<id>.<ext>`. */
  fileKey: string;
  format: AudioFormat;
  bytes: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  uploadedBy: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<FlowAudioDoc>({
  name: { type: String, required: true, trim: true, maxlength: FLOW_LIMITS.nameMaxChars },
  fileKey: { type: String, required: true },
  format: { type: String, enum: AUDIO_FORMATS, required: true },
  bytes: { type: Number, required: true, min: 1, max: FLOW_LIMITS.audioMaxBytes },
  durationMs: { type: Number, required: true, min: 1, max: FLOW_LIMITS.audioMaxMs },
  sampleRate: { type: Number, required: true, min: 8000, max: 48_000 },
  channels: { type: Number, required: true, min: 1, max: 2 },
  uploadedBy: { type: Schema.Types.ObjectId, default: null },
});
schema.plugin(basePlugin, { hide: ['deletedAt', 'fileKey'] });
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
schema.index({ accountId: 1, deletedAt: 1, createdAt: -1 });

/** Account audio files for `play_audio` and audio prompts (data-model.md §2.4). */
export const FlowAudioModel: Model<FlowAudioDoc> =
  (mongoose.models.FlowAudio as Model<FlowAudioDoc> | undefined) ??
  mongoose.model<FlowAudioDoc>('FlowAudio', schema, 'flowAudio');
