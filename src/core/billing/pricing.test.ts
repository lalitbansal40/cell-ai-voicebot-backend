import { describe, expect, it } from 'vitest';

import { DEFAULT_RATE_CARD, type RateCardValues } from '../../db/models/rate-card.model';

import { callCharge, estimateCampaign, holdEstimate, spendShares } from './pricing';

const card = (extra: Partial<RateCardValues> = {}): RateCardValues => ({
  ...DEFAULT_RATE_CARD,
  ...extra,
});

describe('callCharge', () => {
  it.each([
    // [pulse, durationSec, billableSeconds, telephony micros at ₹1/min]
    [60, 0, 0, 0],
    [60, 1, 60, 1_000_000],
    [60, 60, 60, 1_000_000],
    [60, 61, 120, 2_000_000],
    [60, 90, 120, 2_000_000],
    [30, 61, 90, 1_500_000],
    [15, 61, 75, 1_250_000],
    [15, 90, 90, 1_500_000],
  ] as const)('pulse %i s, %i s answered → %i billable s', (pulse, duration, billable, micros) => {
    const { totalMicros, breakdown } = callCharge(card({ pulseSeconds: pulse }), {
      answered: true,
      durationSec: duration,
    });
    expect(breakdown.billableSeconds).toBe(billable);
    expect(breakdown.telephonyMicros).toBe(micros);
    expect(totalMicros).toBe(micros);
  });

  it('does not bill unanswered attempts unless the card says so', () => {
    expect(callCharge(card(), { answered: false, durationSec: 25 }).totalMicros).toBe(0);
    const billed = callCharge(card({ billUnansweredAttempts: true }), {
      answered: false,
      durationSec: 25,
    });
    expect(billed.breakdown.billableSeconds).toBe(60);
    expect(billed.totalMicros).toBe(1_000_000);
  });

  it('bills AI per second (rounded up), TTS per 1k chars and commission in bps', () => {
    const c = card({
      callPerMinuteMicros: 1_000_000,
      aiPerMinuteMicros: 6_000_000,
      ttsPer1kCharsMicros: 2_500_000,
      commissionBps: 1500,
    });
    const { totalMicros, breakdown } = callCharge(c, {
      answered: true,
      durationSec: 90,
      aiSeconds: 61,
      ttsChars: 1234,
    });
    expect(breakdown).toMatchObject({
      telephonyMicros: 2_000_000,
      aiMicros: 6_100_000, // 61 s × ₹6/min
      ttsMicros: 3_085_000, // 1,234 chars × ₹2.50 / 1k
      commissionMicros: 1_677_750, // 15 % of 11,185,000
      aiSeconds: 61,
      ttsChars: 1234,
      pulseSeconds: 60,
      answered: true,
      durationSec: 90,
    });
    expect(totalMicros).toBe(12_862_750);
    // per-second AI at an odd rate rounds up, never down
    expect(
      callCharge(card({ aiPerMinuteMicros: 7 }), { answered: true, durationSec: 0, aiSeconds: 1 })
        .breakdown.aiMicros,
    ).toBe(1);
  });

  it('rejects bad usage numbers', () => {
    expect(() => callCharge(card(), { answered: true, durationSec: -1 })).toThrow(/durationSec/);
    expect(() => callCharge(card(), { answered: true, durationSec: 1.5 })).toThrow();
    expect(() => callCharge(card(), { answered: true, durationSec: 86_401 })).toThrow();
    expect(() =>
      callCharge(card(), { answered: true, durationSec: 1, ttsChars: 10_000_001 }),
    ).toThrow(/ttsChars/);
  });
});

describe('estimates', () => {
  it('holds 3 minutes of call + AI by default', () => {
    expect(holdEstimate(card())).toBe(3 * 1_000_000 + 3 * 6_000_000);
    expect(holdEstimate(card({ commissionBps: 1000 }), 2)).toBe(15_400_000);
    expect(() => holdEstimate(card(), -1)).toThrow();
  });

  it('estimates a campaign with integer math', () => {
    const e = estimateCampaign(card(), {
      calls: 100,
      avgDurationSec: 90,
      answerRateBps: 5000,
      aiShareBps: 5000,
    });
    // 50 answered × (2 min × ₹1 + 45 s AI × ₹6/min = ₹4.50) = ₹6.50 each
    expect(e).toEqual({
      answeredCalls: 50,
      billableSeconds: 50 * 120,
      perCallMicros: 6_500_000,
      totalMicros: 325_000_000,
    });
    expect(() =>
      estimateCampaign(card(), {
        calls: 1,
        avgDurationSec: 1,
        answerRateBps: 10_001,
        aiShareBps: 0,
      }),
    ).toThrow(/answerRateBps/);
  });
});

describe('spendShares', () => {
  it('allocates commission pro rata, remainder to call', () => {
    expect(
      spendShares({ telephonyMicros: 2, aiMicros: 6, ttsMicros: 3, commissionMicros: 10 }),
    ).toEqual({ callMicros: 2 + (10 - 5 - 2), aiMicros: 6 + 5, ttsMicros: 3 + 2 });
    expect(
      spendShares({ telephonyMicros: 0, aiMicros: 0, ttsMicros: 0, commissionMicros: 0 }),
    ).toEqual({ callMicros: 0, aiMicros: 0, ttsMicros: 0 });
    expect(
      spendShares({ telephonyMicros: 0, aiMicros: 0, ttsMicros: 0, commissionMicros: 4 }),
    ).toEqual({ callMicros: 4, aiMicros: 0, ttsMicros: 0 });
  });
});
