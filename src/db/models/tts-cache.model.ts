import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';

export interface TtsCacheDoc {
  _id: Types.ObjectId;
  /** sha256 of model + voice + language + tone + text — the text itself is never stored here. */
  key: string;
  model: string;
  voice: string;
  language: string;
  chars: number;
  /** Storage key of the PCM16 24 kHz audio. */
  fileKey: string;
  durationMs: number;
  hits: number;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<TtsCacheDoc>({
  key: { type: String, required: true },
  model: { type: String, required: true },
  voice: { type: String, required: true },
  language: { type: String, required: true },
  chars: { type: Number, required: true, min: 0 },
  fileKey: { type: String, required: true },
  durationMs: { type: Number, required: true, min: 0 },
  hits: { type: Number, default: 0 },
  lastUsedAt: { type: Date, required: true },
});
schema.plugin(basePlugin);
schema.index({ key: 1 }, { unique: true });
schema.index({ lastUsedAt: 1 });

/** Platform-wide text-to-speech audio cache (Phase 7) — keyed by a hash, no tenant data. */
export const TtsCacheModel: Model<TtsCacheDoc> =
  (mongoose.models.TtsCache as Model<TtsCacheDoc> | undefined) ??
  mongoose.model<TtsCacheDoc>('TtsCache', schema, 'ttsCache');
