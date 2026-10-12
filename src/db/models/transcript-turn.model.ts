import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const TRANSCRIPT_SPEAKERS = ['customer', 'bot', 'agent'] as const;
export type TranscriptSpeaker = (typeof TRANSCRIPT_SPEAKERS)[number];
export const TRANSCRIPT_SOURCES = ['tts', 'ai', 'stt', 'dtmf', 'audio', 'system'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

export interface TranscriptTurnDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  callId: Types.ObjectId;
  seq: number;
  speaker: TranscriptSpeaker;
  /** PII — never logged. */
  text: string;
  language: string | null;
  /** Milliseconds from the moment the call was answered. */
  startMs: number;
  endMs: number;
  interrupted: boolean;
  source: TranscriptSource;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<TranscriptTurnDoc>({
  callId: { type: Schema.Types.ObjectId, required: true },
  seq: { type: Number, required: true, min: 1 },
  speaker: { type: String, enum: TRANSCRIPT_SPEAKERS, required: true },
  text: { type: String, default: '', maxlength: 4000 },
  language: { type: String, default: null },
  startMs: { type: Number, default: 0, min: 0 },
  endMs: { type: Number, default: 0, min: 0 },
  interrupted: { type: Boolean, default: false },
  source: { type: String, enum: TRANSCRIPT_SOURCES, required: true },
});
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.index({ callId: 1, seq: 1 }, { unique: true });

/** Final transcript lines of a call (data-model.md TranscriptTurn). */
export const TranscriptTurnModel: Model<TranscriptTurnDoc> =
  (mongoose.models.TranscriptTurn as Model<TranscriptTurnDoc> | undefined) ??
  mongoose.model<TranscriptTurnDoc>('TranscriptTurn', schema, 'transcriptTurns');
