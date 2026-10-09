import type { RateCardValues } from '../../db/models/rate-card.model';
import { assertMicros } from '../../shared/money';

import type { TokenUsage } from './types';

/** `ceil(tokens × ratePer1k / 1000)` — integers only, never rounds a charge down. */
export const tokensToMicros = (tokens: number, ratePer1kMicros: number): number => {
  assertMicros(tokens);
  assertMicros(ratePer1kMicros);
  if (tokens === 0 || ratePer1kMicros === 0) return 0;
  return assertMicros(Math.floor((tokens * ratePer1kMicros + 999) / 1000));
};

/** Cost of one text turn (input + output tokens at the AI text rate). */
export const turnCost = (
  card: Pick<RateCardValues, 'aiTextPer1kTokensMicros'>,
  usage: TokenUsage,
): number => tokensToMicros(usage.inputTokens + usage.outputTokens, card.aiTextPer1kTokensMicros);

/** Cost of embedding `tokens` (knowledge ingest). */
export const embedCost = (
  card: Pick<RateCardValues, 'embeddingPer1kTokensMicros'>,
  tokens: number,
): number => tokensToMicros(tokens, card.embeddingPer1kTokensMicros);
