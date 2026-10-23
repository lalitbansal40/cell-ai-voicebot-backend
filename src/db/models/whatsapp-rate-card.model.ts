import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';

export const RATE_CARD_SOURCES = ['meta_csv', 'manual'] as const;
export type RateCardSource = (typeof RATE_CARD_SOURCES)[number];

/** The market every unknown calling code falls back to (required on every card). */
export const OTHER_MARKET = 'OTHER';
export const MARKET_PATTERN = /^[A-Z_]{2,40}$/;
export const CALLING_CODE_PATTERN = /^\d{1,4}$/;

export interface RateTier {
  /** Monthly messages from which this rate applies (Meta volume tiers). */
  fromMessages: number;
  micros: number;
}

/** Meta's per-message rates for one market (INR micros, before our markup). */
export interface RateCardMarket {
  market: string;
  label: string;
  callingCodes: string[];
  marketingMicros: number;
  utilityMicros: number;
  authenticationMicros: number;
  authenticationInternationalMicros: number | null;
  serviceMicros: number;
  utilityTiers: RateTier[];
  authenticationTiers: RateTier[];
}

export interface WhatsAppRateCardDoc {
  _id: Types.ObjectId;
  effectiveFrom: Date;
  currency: 'INR';
  source: RateCardSource;
  note: string | null;
  createdBy: Types.ObjectId | null;
  markets: RateCardMarket[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Seed rates (Meta list rates seen 23 Oct 2026, to be confirmed by the owner):
 * marketing ₹0.8631, utility / authentication / service ₹0.115 — markets IN + OTHER.
 */
export const PLACEHOLDER_RATE_CARD_NOTE = "Placeholder — replace with Meta's INR rate card";
export const PLACEHOLDER_MARKETS: RateCardMarket[] = [
  {
    market: 'IN',
    label: 'India',
    callingCodes: ['91'],
    marketingMicros: 863_100,
    utilityMicros: 115_000,
    authenticationMicros: 115_000,
    authenticationInternationalMicros: null,
    serviceMicros: 115_000,
    utilityTiers: [],
    authenticationTiers: [],
  },
  {
    market: OTHER_MARKET,
    label: 'Other',
    callingCodes: [],
    marketingMicros: 863_100,
    utilityMicros: 115_000,
    authenticationMicros: 115_000,
    authenticationInternationalMicros: null,
    serviceMicros: 115_000,
    utilityTiers: [],
    authenticationTiers: [],
  },
];

const microsValidator = {
  validator: (v: unknown) => v === null || (isMicros(v) && v >= 0),
  message: 'Must be a whole number of micros ≥ 0',
};
const rate = { type: Number, required: true, validate: microsValidator };

const tier = new Schema<RateTier>(
  {
    fromMessages: { type: Number, required: true, min: 0 },
    micros: rate,
  },
  { _id: false },
);

const market = new Schema<RateCardMarket>(
  {
    market: { type: String, required: true, match: MARKET_PATTERN },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    callingCodes: {
      type: [{ type: String, match: CALLING_CODE_PATTERN }],
      default: [],
    },
    marketingMicros: rate,
    utilityMicros: rate,
    authenticationMicros: rate,
    authenticationInternationalMicros: {
      type: Number,
      default: null,
      validate: microsValidator,
    },
    serviceMicros: rate,
    utilityTiers: { type: [tier], default: [] },
    authenticationTiers: { type: [tier], default: [] },
  },
  { _id: false },
);

/** Problems of a market list (empty = valid) — shared by the model and the import preview. */
export const rateCardProblems = (markets: readonly RateCardMarket[]): string[] => {
  const problems: string[] = [];
  if (markets.length > WHATSAPP_BILLING_LIMITS.rateCardMarketsMax) {
    problems.push(`At most ${String(WHATSAPP_BILLING_LIMITS.rateCardMarketsMax)} markets`);
  }
  const others = markets.filter((m) => m.market === OTHER_MARKET).length;
  if (others !== 1) problems.push(`Exactly one ${OTHER_MARKET} market is required`);
  const names = new Set<string>();
  const codes = new Map<string, string>();
  for (const m of markets) {
    if (names.has(m.market)) problems.push(`Market ${m.market} is listed twice`);
    names.add(m.market);
    for (const code of m.callingCodes) {
      const owner = codes.get(code);
      if (owner !== undefined && owner !== m.market) {
        problems.push(`Calling code ${code} is in ${owner} and ${m.market}`);
      } else if (owner === m.market) {
        problems.push(`Calling code ${code} is listed twice in ${m.market}`);
      }
      codes.set(code, m.market);
    }
  }
  return problems;
};

const schema = new Schema<WhatsAppRateCardDoc>({
  effectiveFrom: { type: Date, required: true },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  source: { type: String, enum: RATE_CARD_SOURCES, required: true },
  note: { type: String, default: null, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, default: null },
  markets: {
    type: [market],
    required: true,
    validate: {
      validator: (v: RateCardMarket[]) => rateCardProblems(v).length === 0,
      message: (props: { value: RateCardMarket[] }) => rateCardProblems(props.value).join('; '),
    },
  },
});
schema.plugin(basePlugin);
schema.index({ effectiveFrom: -1 });

/**
 * Meta's WhatsApp rates per market — platform-wide, insert-only history, no `accountId`
 * (data-model.md §2.9). The card effective at send time prices a message.
 */
export const WhatsAppRateCardModel: Model<WhatsAppRateCardDoc> =
  (mongoose.models.WhatsAppRateCard as Model<WhatsAppRateCardDoc> | undefined) ??
  mongoose.model<WhatsAppRateCardDoc>('WhatsAppRateCard', schema, 'whatsappRateCards');
