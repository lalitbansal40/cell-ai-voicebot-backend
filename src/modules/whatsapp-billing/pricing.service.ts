import type { Types } from 'mongoose';

import { BILLING_LIMITS } from '../../config/limits';
import { holdForWhatsApp, releaseWhatsApp } from '../../core/billing/engine';
import {
  marketFor,
  metaRate,
  sellingPrice,
  type PriceCategory,
  type SellingPrice,
} from '../../core/billing/whatsapp';
import { AccountModel, type AccountWhatsAppBilling } from '../../db/models/account.model';
import type { MessageBilling } from '../../db/models/message.model';
import {
  DEFAULT_WHATSAPP_BILLING_SETTINGS,
  PlatformSettingsModel,
  type WhatsAppBillingSettings,
} from '../../db/models/platform-settings.model';
import {
  MESSAGING_CARDS,
  PLACEHOLDER_MARKETS,
  WhatsAppRateCardModel,
  type RateCardMarket,
  type WhatsAppRateCardDoc,
} from '../../db/models/whatsapp-rate-card.model';

/** The card Meta's rates come from at `at` (cached 60 s for "now"; saving a card invalidates). */
export interface EffectiveWhatsAppRateCard {
  id: string | null;
  effectiveFrom: Date;
  markets: RateCardMarket[];
}

let cached: { card: EffectiveWhatsAppRateCard; at: number } | null = null;
let settingsCache: { value: WhatsAppBillingSettings; at: number } | null = null;

export const invalidateWhatsAppPricingCache = (): void => {
  cached = null;
  settingsCache = null;
};

export const effectiveWhatsAppRateCard = async (at?: Date): Promise<EffectiveWhatsAppRateCard> => {
  const now = Date.now();
  if (!at && cached && now - cached.at < BILLING_LIMITS.rateCardCacheMs) return cached.card;
  const doc = await WhatsAppRateCardModel.findOne({
    ...MESSAGING_CARDS,
    effectiveFrom: { $lte: at ?? new Date(now) },
  })
    .sort({ effectiveFrom: -1, _id: -1 })
    .lean<WhatsAppRateCardDoc>();
  // before migration 0012 ran: the placeholder card (never a free message by accident)
  const card: EffectiveWhatsAppRateCard = doc
    ? { id: doc._id.toString(), effectiveFrom: doc.effectiveFrom, markets: doc.markets }
    : { id: null, effectiveFrom: new Date(0), markets: PLACEHOLDER_MARKETS };
  if (!at) cached = { card, at: now };
  return card;
};

/** Platform settings (superadmin) with code defaults for missing fields. */
export const whatsAppBillingSettings = async (): Promise<WhatsAppBillingSettings> => {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < BILLING_LIMITS.rateCardCacheMs) {
    return settingsCache.value;
  }
  const row = await PlatformSettingsModel.findOne({ key: 'whatsappBilling' }).lean<{
    value?: Partial<WhatsAppBillingSettings>;
  }>();
  const value = { ...DEFAULT_WHATSAPP_BILLING_SETTINGS, ...(row?.value ?? {}) };
  settingsCache = { value, at: now };
  return value;
};

/** The account's override (superadmin) — null fields use the platform settings. */
export const accountWhatsAppPricing = async (
  accountId: Types.ObjectId,
): Promise<AccountWhatsAppBilling | null> => {
  const account = await AccountModel.findById(accountId)
    .select({ whatsappBilling: 1 })
    .lean<{ whatsappBilling?: AccountWhatsAppBilling | null }>();
  return account?.whatsappBilling ?? null;
};

export interface PriceQuote extends SellingPrice {
  market: string;
  marketLabel: string;
  category: PriceCategory;
  payer: 'platform' | 'customer';
  markupBps: number;
  rateCardId: string | null;
}

/**
 * The price of one message to `phoneE164` in `category` for this account and payer:
 * Meta's rate (card in force at `at`), the account's fixed price or markup, the fee.
 */
export const priceMessage = async (input: {
  accountId: Types.ObjectId;
  payer: 'platform' | 'customer';
  phoneE164: string;
  category: PriceCategory;
  at?: Date;
}): Promise<PriceQuote> => {
  const [card, settings, override] = await Promise.all([
    effectiveWhatsAppRateCard(input.at),
    whatsAppBillingSettings(),
    accountWhatsAppPricing(input.accountId),
  ]);
  const market = marketFor(input.phoneE164, card.markets);
  const markupBps = override?.markupBps ?? settings.markupBps;
  const fixedKey =
    input.category === 'authentication_international' ? 'authentication' : input.category;
  const price = sellingPrice({
    metaRateMicros: metaRate(market, input.category),
    markupBps,
    fixedPriceMicros: override?.fixedPrices?.[fixedKey] ?? null,
    platformFeeMicros: override?.platformFeeMicros ?? settings.platformFeeMicros,
    payer: input.payer,
  });
  return {
    ...price,
    market: market.market,
    marketLabel: market.label,
    category: input.category,
    payer: input.payer,
    markupBps,
    rateCardId: card.id,
  };
};

/* ── message holds (send pipeline) ─────────────────────────────────────── */

export interface MessageCharge {
  billing: MessageBilling;
  /** Release this hold when the message can't be stored. */
  holdId: Types.ObjectId | null;
}

/**
 * Prices a message and holds its price (PHASE_11_PROMPT §1: after every non-money
 * rule, before the insert; key `wa-hold-<clientId>` so a duplicate replays it). A
 * customer-pays account with no platform fee holds nothing (`billing.status: none`).
 * Refused → `WALLET_INSUFFICIENT_BALANCE` / `WALLET_BUDGET_EXCEEDED` (`path: whatsapp`).
 */
export const holdMessageCharge = async (input: {
  accountId: Types.ObjectId;
  payer: 'platform' | 'customer';
  phoneE164: string;
  category: PriceCategory;
  clientId: string;
  /** The message's chat (shown as a link on the wallet line). */
  conversationId?: Types.ObjectId | null;
  now: Date;
}): Promise<MessageCharge> => {
  const quote = await priceMessage({
    accountId: input.accountId,
    payer: input.payer,
    phoneE164: input.phoneE164,
    category: input.category,
    at: input.now,
  });
  const base: MessageBilling = {
    payer: input.payer,
    market: quote.market,
    category: input.category,
    estimateMicros: quote.priceMicros,
    priceMicros: quote.priceMicros,
    metaCostMicros: quote.metaCostMicros,
    holdId: null,
    status: 'none',
    billable: null,
    pricingType: null,
    metaCategory: null,
    categoryMismatch: false,
    at: input.now,
  };
  if (quote.priceMicros <= 0) return { billing: base, holdId: null };
  const res = await holdForWhatsApp({
    accountId: input.accountId,
    clientId: input.clientId,
    amountMicros: quote.priceMicros,
    breakdown: {
      waCategory: input.category,
      waMarket: quote.market,
      metaCostMicros: quote.metaCostMicros,
      markupMicros: quote.markupMicros,
      platformFeeMicros: quote.platformFeeMicros,
      ...(input.conversationId ? { waConversationId: input.conversationId.toString() } : {}),
    },
    ref: { type: 'whatsapp_message', id: input.clientId },
  });
  const holdId = res.entries[0]?._id ?? null;
  return { billing: { ...base, holdId, status: holdId ? 'held' : 'none' }, holdId };
};

/** The insert failed after the hold: give it back. */
export const releaseMessageCharge = async (
  accountId: Types.ObjectId,
  holdId: Types.ObjectId | null,
): Promise<void> => {
  if (!holdId) return;
  await releaseWhatsApp({ accountId, holdId, reason: 'send_aborted' });
};

/** Selling prices per market × category for an account (Wallet → Prices; never Meta's rates). */
export const sellingPriceTable = async (
  accountId: Types.ObjectId,
  payer: 'platform' | 'customer',
) => {
  const [card, settings, override] = await Promise.all([
    effectiveWhatsAppRateCard(),
    whatsAppBillingSettings(),
    accountWhatsAppPricing(accountId),
  ]);
  const markupBps = override?.markupBps ?? settings.markupBps;
  const fee = override?.platformFeeMicros ?? settings.platformFeeMicros;
  const price = (
    market: RateCardMarket,
    category: 'marketing' | 'utility' | 'authentication' | 'service',
  ) =>
    sellingPrice({
      metaRateMicros: metaRate(market, category),
      markupBps,
      fixedPriceMicros: override?.fixedPrices?.[category] ?? null,
      platformFeeMicros: fee,
      payer,
    }).priceMicros;
  return {
    payer,
    effectiveFrom: card.effectiveFrom.toISOString(),
    markets: card.markets.map((m) => ({
      market: m.market,
      label: m.label,
      prices: {
        marketing: price(m, 'marketing'),
        utility: price(m, 'utility'),
        authentication: price(m, 'authentication'),
        service: price(m, 'service'),
      },
    })),
  };
};
