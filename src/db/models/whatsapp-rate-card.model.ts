import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { isMicros } from '../../shared/money';
import { basePlugin } from '../plugins/base';

export const RATE_CARD_SOURCES = ['meta_csv', 'manual'] as const;
export type RateCardSource = (typeof RATE_CARD_SOURCES)[number];

/** `messaging` = per-message rates (Phase 11); `calling` = per-minute call rates (Phase 12). */
export const RATE_CARD_KINDS = ['messaging', 'calling'] as const;
export type RateCardKind = (typeof RATE_CARD_KINDS)[number];

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

export interface CallingRateTier {
  /** Monthly call minutes from which this rate applies (Meta volume tiers). */
  fromMinutes: number;
  perMinuteMicros: number;
}

/** Meta's business-initiated call rate for one market (INR micros per minute, before our markup). */
export interface CallingRateMarket {
  market: string;
  label: string;
  callingCodes: string[];
  perMinuteMicros: number;
  tiers: CallingRateTier[];
}

export interface WhatsAppRateCardDoc {
  _id: Types.ObjectId;
  /** Absent on cards saved before migration 0013 (= `messaging`). */
  kind: RateCardKind;
  effectiveFrom: Date;
  currency: 'INR';
  source: RateCardSource;
  note: string | null;
  createdBy: Types.ObjectId | null;
  /** Messaging cards; empty on calling cards. */
  markets: RateCardMarket[];
  /** Calling cards; empty on messaging cards. */
  callingMarkets: CallingRateMarket[];
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

/**
 * Seed call rates (third-party quote for India seen 24 Oct 2026, to be confirmed by
 * the owner): IN ₹0.3885 / min, OTHER ₹1 / min — base tier only.
 */
export const PLACEHOLDER_CALLING_RATE_CARD_NOTE =
  "Placeholder — replace with Meta's INR calling rate card";
export const PLACEHOLDER_CALLING_MARKETS: CallingRateMarket[] = [
  { market: 'IN', label: 'India', callingCodes: ['91'], perMinuteMicros: 388_500, tiers: [] },
  { market: OTHER_MARKET, label: 'Other', callingCodes: [], perMinuteMicros: 1_000_000, tiers: [] },
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

const callingTier = new Schema<CallingRateTier>(
  {
    fromMinutes: { type: Number, required: true, min: 0 },
    perMinuteMicros: rate,
  },
  { _id: false },
);

const callingMarket = new Schema<CallingRateMarket>(
  {
    market: { type: String, required: true, match: MARKET_PATTERN },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    callingCodes: {
      type: [{ type: String, match: CALLING_CODE_PATTERN }],
      default: [],
    },
    perMinuteMicros: rate,
    tiers: { type: [callingTier], default: [] },
  },
  { _id: false },
);

interface MarketCodes {
  market: string;
  callingCodes: string[];
}

/** Problems of a market list (empty = valid) — shared by the model and the import preview. */
export const rateCardProblems = (markets: readonly MarketCodes[]): string[] => {
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
  kind: { type: String, enum: RATE_CARD_KINDS, default: 'messaging' },
  effectiveFrom: { type: Date, required: true },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  source: { type: String, enum: RATE_CARD_SOURCES, required: true },
  note: { type: String, default: null, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, default: null },
  markets: { type: [market], default: [] },
  callingMarkets: { type: [callingMarket], default: [] },
});
// one market list per card kind, each with exactly one OTHER and no shared calling codes
schema.pre('validate', function () {
  const calling = this.kind === 'calling';
  const [used, unused] = calling
    ? (['callingMarkets', 'markets'] as const)
    : (['markets', 'callingMarkets'] as const);
  const problems = rateCardProblems(this[used]);
  if (problems.length) this.invalidate(used, problems.join('; '));
  if (this[unused].length) this.invalidate(unused, `Not used on ${this.kind} cards`);
});
schema.plugin(basePlugin);
schema.index({ effectiveFrom: -1 });
schema.index({ kind: 1, effectiveFrom: -1 }, { name: 'kind_effective_from' });

/** Filter for messaging cards (cards saved before migration 0013 have no `kind`). */
export const MESSAGING_CARDS = { kind: { $ne: 'calling' } } as const;

/**
 * Meta's WhatsApp rates per market — platform-wide, insert-only history, no `accountId`
 * (data-model.md §2.9). The card effective at send time prices a message.
 */
export const WhatsAppRateCardModel: Model<WhatsAppRateCardDoc> =
  (mongoose.models.WhatsAppRateCard as Model<WhatsAppRateCardDoc> | undefined) ??
  mongoose.model<WhatsAppRateCardDoc>('WhatsAppRateCard', schema, 'whatsappRateCards');
