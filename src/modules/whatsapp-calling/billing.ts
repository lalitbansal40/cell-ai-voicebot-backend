import type { Types } from 'mongoose';

import { CALL_LIMITS, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import {
  extendWhatsAppCallHold,
  holdForWhatsAppCall,
  releaseWhatsAppCallHold,
  settleWhatsAppCall,
} from '../../core/billing/engine';
import type { CallUsage } from '../../core/billing/pricing';
import { marketFor } from '../../core/billing/whatsapp';
import {
  callHoldMicros,
  callPrice,
  type CallPrice,
  type CallPriceInput,
} from '../../core/billing/whatsapp-calls';
import { AccountModel, type AccountWhatsAppCallingBilling } from '../../db/models/account.model';
import { emptyCallCost, type CallCost } from '../../db/models/call.model';
import {
  DEFAULT_WHATSAPP_CALLING_SETTINGS,
  PlatformSettingsModel,
  type WhatsAppCallingSettings,
} from '../../db/models/platform-settings.model';
import {
  PLACEHOLDER_CALLING_MARKETS,
  WhatsAppRateCardModel,
  type CallingRateMarket,
} from '../../db/models/whatsapp-rate-card.model';
import { CallBilling, type CallBillingPort } from '../calls/billing';

/**
 * WhatsApp call money (PHASE_12_PLAN §1i): the called number's market on the calling
 * card in force at dial, the platform call settings and the account's override.
 */
export interface CallQuote extends CallPriceInput {
  market: string;
  rateCardId: string | null;
  holdMinutes: number;
  holdExtendMinutes: number;
}

export const effectiveCallingCard = async (
  at = new Date(),
): Promise<{ id: string | null; markets: CallingRateMarket[] }> => {
  const doc = await WhatsAppRateCardModel.findOne({ kind: 'calling', effectiveFrom: { $lte: at } })
    .sort({ effectiveFrom: -1, _id: -1 })
    .select({ callingMarkets: 1 })
    .lean<{ _id: Types.ObjectId; callingMarkets: CallingRateMarket[] }>();
  return doc
    ? { id: doc._id.toString(), markets: doc.callingMarkets }
    : { id: null, markets: PLACEHOLDER_CALLING_MARKETS };
};

export const whatsAppCallingSettings = async (): Promise<WhatsAppCallingSettings> => {
  const row = await PlatformSettingsModel.findOne({ key: 'whatsappCalling' }).lean<{
    value?: Partial<WhatsAppCallingSettings>;
  }>();
  return { ...DEFAULT_WHATSAPP_CALLING_SETTINGS, ...(row?.value ?? {}) };
};

export const quoteCall = async (input: {
  accountId: Types.ObjectId;
  phoneE164: string;
  payer: 'platform' | 'customer';
  at?: Date;
}): Promise<CallQuote> => {
  const [card, settings, account] = await Promise.all([
    effectiveCallingCard(input.at),
    whatsAppCallingSettings(),
    AccountModel.findById(input.accountId)
      .select({ whatsappCallingBilling: 1 })
      .lean<{ whatsappCallingBilling?: AccountWhatsAppCallingBilling | null }>(),
  ]);
  const market = marketFor(input.phoneE164, card.markets);
  const own = account?.whatsappCallingBilling ?? null;
  return {
    market: market.market,
    rateCardId: card.id,
    perMinuteMicros: market.perMinuteMicros,
    markupBps: own?.markupBps ?? settings.markupBps,
    fixedPerMinuteMicros: own?.fixedPerMinuteMicros ?? null,
    platformFeePerMinuteMicros:
      own?.platformFeePerMinuteMicros ?? settings.platformFeePerMinuteMicros,
    payer: input.payer,
    holdMinutes: settings.holdMinutes,
    holdExtendMinutes: settings.holdExtendMinutes,
  };
};

/** Ledger breakdown of a call charge (Meta cost / markup / fee are superadmin-only in views). */
export const callBreakdown = (
  quote: CallQuote,
  price: CallPrice,
  durationSec: number,
  conversationId: string | null,
) => ({
  waMarket: quote.market,
  waPulses: price.pulses,
  waPerMinuteMicros: quote.perMinuteMicros,
  metaCostMicros: price.metaCostMicros,
  markupMicros: price.markupMicros,
  platformFeeMicros: price.platformFeeMicros,
  durationSec,
  ...(conversationId ? { waConversationId: conversationId } : {}),
});

export interface SettledCallCharge {
  ledgerEntryId: string | null;
  price: CallPrice;
  durationSec: number;
  source: 'meta' | 'ours';
}

/**
 * The money of one WhatsApp call as the Phase 7 session sees it (`CallBillingPort`):
 * a call-price hold (business-initiated calls; free user-initiated calls hold nothing)
 * plus, on AI calls, the Phase 7 AI hold — two holds, both extended and both settled.
 * The call part settles on Meta's `duration` (`settleCallPart`), the AI part with the
 * session's usage.
 */
export class WhatsAppCallBilling implements CallBillingPort {
  private callHoldId: string | null = null;
  private readonly ai: CallBilling | null;
  private coveredSec = 0;
  private extensions = 0;
  private callSettled: SettledCallCharge | null = null;
  private settlingCall: Promise<SettledCallCharge> | null = null;

  constructor(
    private readonly input: {
      accountId: string;
      callId: string;
      quote: CallQuote;
      /** Business-initiated: Meta bills the call. */
      charged: boolean;
      /** AI calls also hold / settle AI usage (Phase 7 path, no telephony). */
      withAi: boolean;
      conversationId: string | null;
    },
  ) {
    this.ai = input.withAi ? new CallBilling(input.accountId, input.callId, false) : null;
  }

  get holdId(): string | null {
    return this.callHoldId ?? this.ai?.holdId ?? null;
  }

  get callHold(): string | null {
    return this.callHoldId;
  }

  get aiHold(): string | null {
    return this.ai?.holdId ?? null;
  }

  /** Both holds at dial; a refused AI hold gives the call hold back. */
  async hold(): Promise<void> {
    const { quote } = this.input;
    if (this.input.charged) {
      const amount = callHoldMicros(quote, quote.holdMinutes);
      if (amount > 0) {
        const r = await holdForWhatsAppCall({
          accountId: this.input.accountId,
          callId: this.input.callId,
          amountMicros: amount,
          breakdown: { waMarket: quote.market, waPerMinuteMicros: quote.perMinuteMicros },
        });
        this.callHoldId = r.entries[0]?._id.toString() ?? null;
      }
    }
    this.coveredSec = quote.holdMinutes * 60;
    if (this.ai) {
      try {
        await this.ai.hold();
      } catch (err) {
        await this.releaseCall('ai_hold_refused');
        throw err;
      }
    }
  }

  needsExtension(elapsedSec: number): boolean {
    const call =
      this.callHoldId !== null && this.coveredSec - elapsedSec < CALL_LIMITS.holdLowWaterSec;
    return call || (this.ai?.needsExtension(elapsedSec) ?? false);
  }

  async extend(): Promise<boolean> {
    let ok = true;
    if (this.callHoldId && this.input.charged) {
      this.extensions += 1;
      const r = await extendWhatsAppCallHold({
        accountId: this.input.accountId,
        holdId: this.callHoldId,
        callId: this.input.callId,
        n: this.extensions,
        amountMicros: callHoldMicros(this.input.quote, this.input.quote.holdExtendMinutes),
      });
      if (r.ok) this.coveredSec += this.input.quote.holdExtendMinutes * 60;
      ok = r.ok;
    }
    if (this.ai && ok) ok = await this.ai.extend();
    return ok;
  }

  /** AI usage now (Phase 7); the call part follows Meta's duration (`settleCallPart`). */
  async settle(
    usage: Omit<CallUsage, 'telephony'>,
  ): Promise<{ ledgerEntryId: string | null; cost: CallCost }> {
    const ai = this.ai?.holdId
      ? await this.ai.settle(usage)
      : { ledgerEntryId: null, cost: emptyCallCost() };
    const call = this.callSettled;
    const callMicros = call?.price.totalMicros ?? 0;
    return {
      ledgerEntryId: ai.ledgerEntryId ?? call?.ledgerEntryId ?? null,
      cost: {
        ...ai.cost,
        telephonyMicros: ai.cost.telephonyMicros + callMicros,
        totalMicros: ai.cost.totalMicros + callMicros,
      },
    };
  }

  async release(reason: string): Promise<void> {
    await this.releaseCall(reason);
    if (this.ai?.holdId) await this.ai.release(reason);
  }

  private async releaseCall(reason: string): Promise<void> {
    if (!this.callHoldId) return;
    await releaseWhatsAppCallHold({
      accountId: this.input.accountId,
      holdId: this.callHoldId,
      reason,
    });
  }

  /**
   * Charges the call from its talk time (`source: meta` = the terminate webhook's
   * `duration`, `ours` = our measured time after `lateTerminateGraceSec`). Once.
   */
  async settleCallPart(durationSec: number, source: 'meta' | 'ours'): Promise<SettledCallCharge> {
    if (this.callSettled) return this.callSettled;
    if (this.settlingCall) return this.settlingCall;
    this.settlingCall = this.performCallSettlement(durationSec, source);
    try {
      return await this.settlingCall;
    } finally {
      this.settlingCall = null;
    }
  }

  private async performCallSettlement(
    durationSec: number,
    source: 'meta' | 'ours',
  ): Promise<SettledCallCharge> {
    const price = callPrice(this.input.quote, this.input.charged ? durationSec : 0);
    let ledgerEntryId: string | null = null;
    if (this.callHoldId) {
      const r = await settleWhatsAppCall({
        accountId: this.input.accountId,
        holdId: this.callHoldId,
        callId: this.input.callId,
        amountMicros: price.totalMicros,
        breakdown: callBreakdown(this.input.quote, price, durationSec, this.input.conversationId),
        note:
          source === 'ours' ? 'Meta duration not received in time — our measured talk time' : null,
      });
      ledgerEntryId = r.entries[0]?._id.toString() ?? null;
    }
    this.callSettled = { ledgerEntryId, price, durationSec, source };
    return this.callSettled;
  }

  get settledCall(): SettledCallCharge | null {
    return this.callSettled;
  }
}

/** Grace for Meta's terminate webhook before we charge our own measured time. */
export const LATE_TERMINATE_GRACE_MS = WHATSAPP_CALL_LIMITS.lateTerminateGraceSec * 1000;
