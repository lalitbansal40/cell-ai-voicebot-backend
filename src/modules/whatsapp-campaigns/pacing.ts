import type { WaLimitTier } from '../../db/models/whatsapp-channel.model';

/** Meta's messaging limit: unique people a number may start conversations with per 24 h. */
export const TIER_LIMITS: Record<WaLimitTier, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
};

/** Default throughput (Meta's standard 80 messages / second); env `WA_CAMPAIGN_MPS`. */
export const campaignMps = (): number => {
  const v = Number(process.env.WA_CAMPAIGN_MPS ?? 80);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1_000) : 80;
};

/**
 * How many new people the number may message now: the tier minus who it already messaged
 * in the last 24 h (unknown tier = the lowest, 250). Pure.
 */
export const allowedNow = (input: { tier: WaLimitTier | null; sentLast24h: number }): number => {
  const cap = TIER_LIMITS[input.tier ?? 'TIER_250'];
  return Math.max(0, cap - input.sentLast24h);
};

/** Milliseconds between batches of `batch` messages at `mps`. */
export const batchGapMs = (batch: number, mps = campaignMps()): number =>
  Math.ceil((batch / mps) * 1000);
