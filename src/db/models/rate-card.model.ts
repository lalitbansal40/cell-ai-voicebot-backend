import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';

export const PULSE_SECONDS = [15, 30, 60] as const;
export type PulseSeconds = (typeof PULSE_SECONDS)[number];

export interface RateCardValues {
  callPerMinuteMicros: number;
  pulseSeconds: PulseSeconds;
  aiPerMinuteMicros: number;
  ttsPer1kCharsMicros: number;
  /** Platform margin on top, basis points (1500 = 15 %). */
  commissionBps: number;
  /** Charge the pulse-rounded duration of unanswered attempts too (default no). */
  billUnansweredAttempts: boolean;
  /** AI text (playground, later calls' text turns) per 1,000 tokens in + out (Phase 5). */
  aiTextPer1kTokensMicros: number;
  /** Knowledge-base embeddings per 1,000 tokens (Phase 5). */
  embeddingPer1kTokensMicros: number;
}

export interface RateCardDoc extends RateCardValues {
  _id: Types.ObjectId;
  /** `null` = the platform default card (exception to the tenant rule). */
  accountId: Types.ObjectId | null;
  /** Account row that means "use the platform default again". */
  inheritsDefault: boolean;
  effectiveFrom: Date;
  createdBy: Types.ObjectId | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Placeholder selling prices until the client confirms (PHASE_4_PLAN §1c / §7). */
export const DEFAULT_RATE_CARD: RateCardValues = {
  callPerMinuteMicros: 1_000_000,
  pulseSeconds: 60,
  aiPerMinuteMicros: 6_000_000,
  ttsPer1kCharsMicros: 2_500_000,
  commissionBps: 0,
  billUnansweredAttempts: false,
  aiTextPer1kTokensMicros: 200_000,
  embeddingPer1kTokensMicros: 10_000,
};

const rate = {
  type: Number,
  required: true,
  validate: {
    validator: (v: unknown) => isMicros(v) && v >= 0,
    message: 'Must be a whole number of micros ≥ 0',
  },
};

const schema = new Schema<RateCardDoc>({
  accountId: { type: Schema.Types.ObjectId, default: null },
  callPerMinuteMicros: rate,
  pulseSeconds: { type: Number, enum: PULSE_SECONDS, required: true },
  aiPerMinuteMicros: rate,
  ttsPer1kCharsMicros: rate,
  commissionBps: { type: Number, required: true, min: 0, max: 10_000 },
  billUnansweredAttempts: { type: Boolean, default: false },
  aiTextPer1kTokensMicros: { ...rate, default: DEFAULT_RATE_CARD.aiTextPer1kTokensMicros },
  embeddingPer1kTokensMicros: { ...rate, default: DEFAULT_RATE_CARD.embeddingPer1kTokensMicros },
  inheritsDefault: { type: Boolean, default: false },
  effectiveFrom: { type: Date, required: true },
  createdBy: { type: Schema.Types.ObjectId, default: null },
  note: { type: String, default: null, maxlength: 300 },
});
schema.plugin(basePlugin);
schema.index({ accountId: 1, effectiveFrom: -1 });

/** Prices per account (history kept, insert-only) — data-model.md §2.3. */
export const RateCardModel: Model<RateCardDoc> =
  (mongoose.models.RateCard as Model<RateCardDoc> | undefined) ??
  mongoose.model<RateCardDoc>('RateCard', schema, 'rateCards');
