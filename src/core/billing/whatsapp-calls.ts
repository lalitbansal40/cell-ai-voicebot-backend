import { WHATSAPP_CALL_LIMITS } from '../../config/limits';

import { ceilToPaise } from './whatsapp';

/**
 * WhatsApp call prices (PHASE_12_PROMPT §1 "Pulse math") — pure, integer micros.
 * Meta bills business-initiated calls in 6-second pulses at a per-minute rate for the
 * called number's market (base tier); we sell at that rate + markup (or the account's
 * fixed per-minute price) + the platform fee, each part rounded **up** to the paisa
 * per call. Customer-pays numbers pay the platform fee only. User-initiated calls are
 * free at Meta.
 */
export const PULSES_PER_MINUTE = 60 / WHATSAPP_CALL_LIMITS.pulseSec;

const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

/** `ceil(duration / 6)`; 0 for a call that never connected. */
export const pulsesFor = (durationSec: number): number =>
  durationSec > 0 ? Math.ceil(durationSec / WHATSAPP_CALL_LIMITS.pulseSec) : 0;

/** Meta's price of one pulse (per-minute ÷ 10, rounded up to the micro). */
export const perPulseMicros = (perMinuteMicros: number): number =>
  ceilDiv(Math.max(0, perMinuteMicros), PULSES_PER_MINUTE);

export interface CallPriceInput {
  /** Meta's per-minute rate of the market (micros). */
  perMinuteMicros: number;
  markupBps: number;
  /** Account fixed selling price per minute (wins over Meta's rate + markup). */
  fixedPerMinuteMicros: number | null;
  platformFeePerMinuteMicros: number;
  payer: 'platform' | 'customer';
}

export interface CallPrice {
  pulses: number;
  metaPerPulseMicros: number;
  metaCostMicros: number;
  markupMicros: number;
  platformFeeMicros: number;
  totalMicros: number;
}

export const callPrice = (input: CallPriceInput, durationSec: number): CallPrice => {
  const pulses = pulsesFor(durationSec);
  const metaPerPulse = perPulseMicros(input.perMinuteMicros);
  const fee = ceilToPaise(pulses * perPulseMicros(input.platformFeePerMinuteMicros));
  if (input.payer === 'customer') {
    return {
      pulses,
      metaPerPulseMicros: metaPerPulse,
      metaCostMicros: 0,
      markupMicros: 0,
      platformFeeMicros: fee,
      totalMicros: fee,
    };
  }
  const metaCost = pulses * metaPerPulse;
  const selling =
    input.fixedPerMinuteMicros !== null
      ? ceilToPaise(pulses * perPulseMicros(input.fixedPerMinuteMicros))
      : ceilToPaise(ceilDiv(metaCost * (10_000 + Math.max(0, input.markupBps)), 10_000));
  return {
    pulses,
    metaPerPulseMicros: metaPerPulse,
    metaCostMicros: metaCost,
    markupMicros: selling - metaCost,
    platformFeeMicros: fee,
    totalMicros: selling + fee,
  };
};

/** What `minutes` of call cost at most (the hold at dial / each extension). */
export const callHoldMicros = (input: CallPriceInput, minutes: number): number =>
  callPrice(input, minutes * 60).totalMicros;
