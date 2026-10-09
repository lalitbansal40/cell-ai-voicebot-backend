import { describe, expect, it, vi } from 'vitest';

import { AI_LIMITS } from '../../config/limits';

import { embedTexts, normalizeVector } from './embed';

describe('embedTexts', () => {
  it('batches, normalises, sums usage and reports progress', async () => {
    const embed = vi.fn(({ inputs }: { inputs: string[] }) =>
      Promise.resolve({ vectors: inputs.map(() => [3, 4]), usage: { tokens: inputs.length } }),
    );
    const progress = vi.fn();
    const texts = Array.from({ length: AI_LIMITS.embedBatch + 5 }, (_, i) => `t${i}`);
    const out = await embedTexts({ embed }, 'm', texts, progress);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(out.tokens).toBe(texts.length);
    expect(out.vectors[0]).toEqual([0.6, 0.8]);
    expect(progress.mock.calls).toEqual([
      [AI_LIMITS.embedBatch, texts.length],
      [texts.length, texts.length],
    ]);
    expect(await embedTexts({ embed }, 'm', [])).toEqual({ vectors: [], tokens: 0 });
  });

  it('refuses a short answer and keeps zero vectors zero', async () => {
    const embed = () => Promise.resolve({ vectors: [[1, 0]], usage: { tokens: 1 } });
    await expect(embedTexts({ embed }, 'm', ['a', 'b'])).rejects.toThrow(
      'Embedding count mismatch',
    );
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });
});
