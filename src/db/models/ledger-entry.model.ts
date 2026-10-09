import mongoose, { Schema, type Model, type Query, type Types } from 'mongoose';

import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const LEDGER_TYPES = [
  'topup',
  'call_charge',
  'ai_charge',
  'tts_charge',
  'adjustment',
  'refund',
  'subscription',
  'recording_charge',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const LEDGER_STATUSES = ['held', 'captured', 'released'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const LEDGER_DIRECTIONS = ['credit', 'debit'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const LEDGER_REF_TYPES = [
  'call',
  'campaign',
  'topup',
  'manual',
  'simulator',
  'usage',
  'seed',
] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

export interface LedgerBreakdown {
  telephonyMicros?: number;
  aiMicros?: number;
  ttsMicros?: number;
  commissionMicros?: number;
  answered?: boolean;
  durationSec?: number;
  billableSeconds?: number;
  pulseSeconds?: number;
  aiSeconds?: number;
  ttsChars?: number;
}

export interface LedgerEntryDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  type: LedgerType;
  direction: LedgerDirection;
  status: LedgerStatus;
  amountMicros: number;
  currency: 'INR';
  /** Wallet balance right after a captured row. */
  balanceAfterMicros?: number | null;
  breakdown?: LedgerBreakdown | null;
  ref: { type: LedgerRefType; id: string };
  /** Charge row → its hold; extension hold row → the first hold row. */
  holdId?: Types.ObjectId | null;
  rateCardId?: Types.ObjectId | null;
  idempotencyKey: string;
  note?: string | null;
  createdBy?: Types.ObjectId | null;
  releasedAt?: Date | null;
  releaseReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const amount = {
  type: Number,
  required: true,
  validate: {
    validator: (v: unknown) => isMicros(v) && v > 0,
    message: 'Must be a positive whole number of micros',
  },
};

const schema = new Schema<LedgerEntryDoc>({
  type: { type: String, enum: LEDGER_TYPES, required: true },
  direction: { type: String, enum: LEDGER_DIRECTIONS, required: true },
  status: { type: String, enum: LEDGER_STATUSES, required: true },
  amountMicros: amount,
  currency: { type: String, enum: ['INR'], default: 'INR', required: true },
  balanceAfterMicros: {
    type: Number,
    default: null,
    validate: { validator: (v: unknown) => v === null || isMicros(v), message: 'Bad amount' },
  },
  breakdown: {
    type: new Schema<LedgerBreakdown>(
      {
        telephonyMicros: Number,
        aiMicros: Number,
        ttsMicros: Number,
        commissionMicros: Number,
        answered: Boolean,
        durationSec: Number,
        billableSeconds: Number,
        pulseSeconds: Number,
        aiSeconds: Number,
        ttsChars: Number,
      },
      { _id: false },
    ),
    default: null,
  },
  ref: {
    type: { type: String, enum: LEDGER_REF_TYPES, required: true },
    id: { type: String, required: true, maxlength: 100 },
  },
  holdId: { type: Schema.Types.ObjectId, default: null },
  rateCardId: { type: Schema.Types.ObjectId, default: null },
  idempotencyKey: { type: String, required: true, maxlength: 200 },
  note: { type: String, default: null, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, default: null },
  releasedAt: { type: Date, default: null },
  releaseReason: { type: String, default: null, maxlength: 60 },
});
schema.plugin(basePlugin, { hide: ['idempotencyKey'] });
schema.plugin(tenantPlugin);
schema.index({ accountId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ accountId: 1, createdAt: -1, _id: -1 });
schema.index({ accountId: 1, 'ref.type': 1, 'ref.id': 1 });
schema.index({ status: 1, createdAt: 1 });
schema.index({ holdId: 1 });

/** Fields a release may set (status held → released); mongoose adds `updatedAt`. */
const RELEASE_FIELDS = new Set(['status', 'releasedAt', 'releaseReason', 'updatedAt']);

export class LedgerImmutableError extends Error {
  constructor(operation: string) {
    super(`Ledger rows are insert-only (blocked ${operation})`);
    this.name = 'LedgerImmutableError';
  }
}

/** The one allowed mutation (data.md): `held` rows → `released`. */
const guardUpdate = function (this: Query<unknown, unknown>, operation: string) {
  const options = this.getOptions() as { ledgerRelease?: boolean };
  if (!options.ledgerRelease) throw new LedgerImmutableError(operation);
  const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
  const keys = Object.keys(update);
  const set = (update.$set ?? {}) as Record<string, unknown>;
  const onlySet = keys.every((k) => k === '$set' || k === '$setOnInsert');
  const fieldsOk = Object.keys(set).every((k) => RELEASE_FIELDS.has(k));
  const filter = this.getFilter() as { status?: unknown };
  if (!onlySet || !fieldsOk || set.status !== 'released' || filter.status !== 'held') {
    throw new LedgerImmutableError(operation);
  }
};

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  schema.pre(op, function () {
    guardUpdate.call(this, op);
  });
}
for (const op of [
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  schema.pre(op, function () {
    const options = this.getOptions() as { allowLedgerDelete?: boolean };
    // Only the dev benchmark cleans up its throw-away account (never in production).
    if (options.allowLedgerDelete && process.env.NODE_ENV !== 'production') return;
    throw new LedgerImmutableError(op);
  });
}
schema.pre('save', function () {
  if (!this.isNew) throw new LedgerImmutableError('save');
});

/** Every money movement, insert-only (data-model.md §2.3, data.md). */
export const LedgerEntryModel: Model<LedgerEntryDoc> =
  (mongoose.models.LedgerEntry as Model<LedgerEntryDoc> | undefined) ??
  mongoose.model<LedgerEntryDoc>('LedgerEntry', schema, 'ledgerEntries');
