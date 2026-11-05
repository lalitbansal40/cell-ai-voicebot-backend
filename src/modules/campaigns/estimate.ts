import type { Types } from 'mongoose';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import { estimateCampaign } from '../../core/billing/pricing';
import { effectiveRateCard } from '../../core/billing/rates';
import { callPrice } from '../../core/billing/whatsapp-calls';
import { CallModel } from '../../db/models/call.model';
import type { CampaignRetry } from '../../db/models/campaign.model';
import { BPS_SCALE, ceilDiv, mulBps } from '../../shared/money';
import type { CallQuote } from '../whatsapp-calling/billing';

/** Default assumptions (PHASE_8_PLAN §1j). */
export const ANSWER_RATE_BPS = 6_000;
/** Share of an answered call spent with the AI when the flow has an AI step. */
export const AI_SHARE_BPS = 5_000;
/** The estimate is shown as ±25 %. */
export const RANGE_BPS = 2_500;

/** Average answered duration of the flow's last real calls (else the default). */
export const averageDurationSec = async (
  accountId: Types.ObjectId,
  flowId: Types.ObjectId | null,
): Promise<number> => {
  const [row] = await CallModel.aggregate<{ avg: number; n: number }>([
    {
      $match: {
        accountId,
        'source.flowId': flowId,
        isTest: false,
        status: 'completed',
        durationSec: { $gt: 0 },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: CAMPAIGN_LIMITS.estimateSampleCalls },
    { $group: { _id: null, avg: { $avg: '$durationSec' }, n: { $sum: 1 } } },
  ]);
  return row?.n ? Math.round(row.avg) : CAMPAIGN_LIMITS.defaultAvgDurationSec;
};

/** Expected dials per contact (bps): 1 + retries × the unanswered share, when retries apply. */
export const expectedAttemptsBps = (retry: CampaignRetry): number => {
  const retriesUnanswered = retry.retryOn.some((r) => r === 'no_answer' || r === 'busy');
  if (!retriesUnanswered) return BPS_SCALE;
  return BPS_SCALE + (retry.maxAttempts - 1) * (BPS_SCALE - ANSWER_RATE_BPS);
};

export interface CampaignCostEstimate {
  contacts: number;
  calls: number;
  perCallMicros: number;
  totalMicros: number;
  minMicros: number;
  maxMicros: number;
  assumptions: {
    avgDurationSec: number;
    answerRateBps: number;
    aiShareBps: number;
    expectedAttempts: number;
  };
}

/**
 * Rough cost of a campaign (Phase 4 `estimateCampaign`): contacts × expected
 * attempts dials, 60 % answered, the flow's average answered duration, half of
 * it with the AI when the flow has an AI step; shown as a ±25 % range. Integer
 * micros only.
 */
export const estimateCost = async (input: {
  accountId: Types.ObjectId;
  flowId: Types.ObjectId | null;
  contacts: number;
  retry: CampaignRetry;
  hasAi: boolean;
  whatsappQuotes?: CallQuote[] | undefined;
  aiShareBps?: number | undefined;
}): Promise<CampaignCostEstimate> => {
  const card = await effectiveRateCard(input.accountId);
  const avgDurationSec = await averageDurationSec(input.accountId, input.flowId);
  const attemptsBps = expectedAttemptsBps(input.retry);
  const calls = ceilDiv(input.contacts * attemptsBps, BPS_SCALE);
  const aiShareBps = input.hasAi ? (input.aiShareBps ?? AI_SHARE_BPS) : 0;
  const est = estimateCampaign(
    input.whatsappQuotes === undefined ? card : { ...card, callPerMinuteMicros: 0 },
    {
      calls,
      avgDurationSec,
      answerRateBps: ANSWER_RATE_BPS,
      aiShareBps,
    },
  );
  if (input.whatsappQuotes) {
    const transport = Math.max(
      0,
      ...input.whatsappQuotes.map((quote) => callPrice(quote, avgDurationSec).totalMicros),
    );
    est.perCallMicros += transport;
    est.totalMicros += transport * est.answeredCalls;
  }
  return {
    contacts: input.contacts,
    calls,
    perCallMicros: est.perCallMicros,
    totalMicros: est.totalMicros,
    minMicros: mulBps(est.totalMicros, BPS_SCALE - RANGE_BPS),
    maxMicros: mulBps(est.totalMicros, BPS_SCALE + RANGE_BPS),
    assumptions: {
      avgDurationSec,
      answerRateBps: ANSWER_RATE_BPS,
      aiShareBps,
      expectedAttempts: attemptsBps / BPS_SCALE,
    },
  };
};
