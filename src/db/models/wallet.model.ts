import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';

/** Default low-balance threshold: ₹500. */
export const DEFAULT_LOW_BALANCE_THRESHOLD_MICROS = 500_000_000;

export interface WalletSpend {
  /** `YYYY-MM` in the account timezone; counters reset when a new month starts. */
  month: string | null;
  callMicros: number;
  aiMicros: number;
  ttsMicros: number;
}

export interface WalletDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  currency: 'INR';
  /** Real money. Below 0 only after a call overran its hold (PHASE_4_PLAN §1a). */
  balanceMicros: number;
  /** Reserved for running calls. */
  holdMicros: number;
  /** Holds may use it; AI / TTS charges never do. */
  creditLimitMicros: number;
  /** 0 = alerts off. */
  lowBalanceThresholdMicros: number;
  /** 0 = unlimited. */
  budgets: { monthlyCallMicros: number; monthlyAiMicros: number };
  spend: WalletSpend;
  alerts: { lowBalanceNotifiedAt: Date | null; exhaustedNotifiedAt: Date | null };
  /** Bumped on every change. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const micros = (min: number | null = 0) => ({
  type: Number,
  required: true,
  default: 0,
  validate: {
    validator: (v: unknown) => isMicros(v) && (min === null || v >= min),
    message: 'Must be a whole number of micros',
  },
});

const schema = new Schema<WalletDoc>({
  // Tenant field declared here (not tenantPlugin): its plain index would clash with the unique one.
  accountId: { type: Schema.Types.ObjectId, required: true },
  currency: { type: String, enum: ['INR'], default: 'INR', required: true },
  balanceMicros: micros(null),
  holdMicros: micros(),
  creditLimitMicros: micros(),
  lowBalanceThresholdMicros: { ...micros(), default: DEFAULT_LOW_BALANCE_THRESHOLD_MICROS },
  budgets: {
    monthlyCallMicros: micros(),
    monthlyAiMicros: micros(),
  },
  spend: {
    month: { type: String, default: null },
    callMicros: micros(),
    aiMicros: micros(),
    ttsMicros: micros(),
  },
  alerts: {
    lowBalanceNotifiedAt: { type: Date, default: null },
    exhaustedNotifiedAt: { type: Date, default: null },
  },
  version: { type: Number, default: 0 },
});
schema.plugin(basePlugin, { hide: ['alerts', 'version'] });
schema.index({ accountId: 1 }, { unique: true });

/**
 * One prepaid wallet per account (data-model.md §2.3). Changed only by
 * `src/core/billing/engine.ts`, always in a transaction with a ledger row.
 */
export const WalletModel: Model<WalletDoc> =
  (mongoose.models.Wallet as Model<WalletDoc> | undefined) ??
  mongoose.model<WalletDoc>('Wallet', schema, 'wallets');
