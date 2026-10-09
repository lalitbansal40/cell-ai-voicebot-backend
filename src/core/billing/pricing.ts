import { BILLING_LIMITS } from '../../config/limits';
import type { RateCardValues } from '../../db/models/rate-card.model';
import { assertMicros, BPS_SCALE, ceilDiv, mulBps, roundDiv } from '../../shared/money';

/** What a finished call used (Phase 7 fills it from the call record). */
export interface CallUsage {
  answered: boolean;
  durationSec: number;
  aiSeconds?: number;
  ttsChars?: number;
}

export interface ChargeBreakdown {
  telephonyMicros: number;
  aiMicros: number;
  ttsMicros: number;
  commissionMicros: number;
  answered: boolean;
  durationSec: number;
  billableSeconds: number;
  pulseSeconds: number;
  aiSeconds: number;
  ttsChars: number;
}

export interface Charge {
  totalMicros: number;
  breakdown: ChargeBreakdown;
}

const MAX_SECONDS = 24 * 60 * 60;
const MAX_CHARS = 10_000_000;

const count = (value: number | undefined, max: number, name: string): number => {
  const v = value ?? 0;
  if (!Number.isSafeInteger(v) || v < 0 || v > max) {
    throw new RangeError(`${name} must be a whole number between 0 and ${max}`);
  }
  return v;
};

/** `ceil(seconds × perMinute / 60)` — per-second pricing, never rounds a charge down. */
const perSecond = (seconds: number, perMinuteMicros: number): number =>
  ceilDiv(seconds * perMinuteMicros, 60);

/**
 * Price of one call (PHASE_4_PLAN §1c). Answered calls are billed by pulse
 * (90 s at a 60 s pulse = 2 min); unanswered ones are free unless the card
 * says otherwise; AI per second; TTS per 1,000 chars; commission on top.
 */
export const callCharge = (card: RateCardValues, usage: CallUsage): Charge => {
  const durationSec = count(usage.durationSec, MAX_SECONDS, 'durationSec');
  const aiSeconds = count(usage.aiSeconds, MAX_SECONDS, 'aiSeconds');
  const ttsChars = count(usage.ttsChars, MAX_CHARS, 'ttsChars');
  const billed = usage.answered || card.billUnansweredAttempts;
  const billableSeconds = billed ? ceilDiv(durationSec, card.pulseSeconds) * card.pulseSeconds : 0;
  const telephonyMicros = perSecond(billableSeconds, card.callPerMinuteMicros);
  const aiMicros = perSecond(aiSeconds, card.aiPerMinuteMicros);
  const ttsMicros = ceilDiv(ttsChars * card.ttsPer1kCharsMicros, 1000);
  const subtotal = telephonyMicros + aiMicros + ttsMicros;
  const commissionMicros = mulBps(subtotal, card.commissionBps);
  return {
    totalMicros: assertMicros(subtotal + commissionMicros),
    breakdown: {
      telephonyMicros,
      aiMicros,
      ttsMicros,
      commissionMicros,
      answered: usage.answered,
      durationSec,
      billableSeconds,
      pulseSeconds: card.pulseSeconds,
      aiSeconds,
      ttsChars,
    },
  };
};

/** Hold for `minutes` of a call with AI the whole time (+ commission). */
export const holdEstimate = (
  card: RateCardValues,
  minutes: number = BILLING_LIMITS.callHoldMinutes,
): number => {
  const seconds = count(minutes, 24 * 60, 'minutes') * 60;
  return callCharge(card, { answered: true, durationSec: seconds, aiSeconds: seconds }).totalMicros;
};

export interface CampaignEstimateInput {
  calls: number;
  avgDurationSec: number;
  /** Share of calls answered, basis points (5000 = 50 %). */
  answerRateBps: number;
  /** Share of an answered call spent with the AI, basis points. */
  aiShareBps: number;
}

export interface CampaignEstimate {
  answeredCalls: number;
  billableSeconds: number;
  perCallMicros: number;
  totalMicros: number;
}

/** Rough campaign cost for the Phase 8 wizard (unanswered attempts priced at 0). */
export const estimateCampaign = (
  card: RateCardValues,
  input: CampaignEstimateInput,
): CampaignEstimate => {
  const calls = count(input.calls, 1_000_000, 'calls');
  const avg = count(input.avgDurationSec, 3600, 'avgDurationSec');
  const answerRate = count(input.answerRateBps, BPS_SCALE, 'answerRateBps');
  const aiShare = count(input.aiShareBps, BPS_SCALE, 'aiShareBps');
  const answeredCalls = roundDiv(calls * answerRate, BPS_SCALE);
  const perCall = callCharge(card, {
    answered: true,
    durationSec: avg,
    aiSeconds: roundDiv(avg * aiShare, BPS_SCALE),
  });
  return {
    answeredCalls,
    billableSeconds: perCall.breakdown.billableSeconds * answeredCalls,
    perCallMicros: perCall.totalMicros,
    totalMicros: assertMicros(perCall.totalMicros * answeredCalls),
  };
};

/**
 * Splits a charge into the wallet's monthly spend counters (and the usage
 * chart — same rule): AI and TTS as billed, everything else (telephony +
 * commission) is call spend.
 */
export const spendShares = (
  b: Pick<ChargeBreakdown, 'telephonyMicros' | 'aiMicros' | 'ttsMicros' | 'commissionMicros'>,
): { callMicros: number; aiMicros: number; ttsMicros: number } => ({
  callMicros: b.telephonyMicros + b.commissionMicros,
  aiMicros: b.aiMicros,
  ttsMicros: b.ttsMicros,
});
