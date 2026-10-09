import { AI_LIMITS } from '../../config/limits';

import type { AiProvider } from './types';

/** Unit length (cosine = dot product); a zero vector stays zero. */
export const normalizeVector = (vector: number[]): number[] => {
  const norm = Math.hypot(...vector);
  return norm > 0 ? vector.map((v) => v / norm) : vector.map(() => 0);
};

/**
 * Embeds texts in batches of `AI_LIMITS.embedBatch`; usage is summed.
 * `onBatch(done, total)` reports progress after every batch.
 */
export const embedTexts = async (
  provider: Pick<AiProvider, 'embed'>,
  model: string,
  texts: string[],
  onBatch?: (done: number, total: number) => void | Promise<void>,
): Promise<{ vectors: number[][]; tokens: number }> => {
  const vectors: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += AI_LIMITS.embedBatch) {
    const batch = texts.slice(i, i + AI_LIMITS.embedBatch);
    const out = await provider.embed({ model, inputs: batch });
    if (out.vectors.length !== batch.length) throw new Error('Embedding count mismatch');
    vectors.push(...out.vectors.map(normalizeVector));
    tokens += out.usage.tokens;
    await onBatch?.(vectors.length, texts.length);
  }
  return { vectors, tokens };
};
