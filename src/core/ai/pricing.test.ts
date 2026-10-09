import { describe, expect, it } from 'vitest';

import { embedCost, tokensToMicros, turnCost } from './pricing';

describe('AI pricing', () => {
  it.each([
    [0, 200_000, 0],
    [1, 200_000, 200],
    [1000, 200_000, 200_000],
    [1001, 200_000, 200_200],
    [3, 1, 1],
    [999, 1, 1],
    [1000, 0, 0],
  ])('%d tokens at %d / 1k → %d micros (rounded up)', (tokens, rate, micros) => {
    expect(tokensToMicros(tokens, rate)).toBe(micros);
  });

  it('refuses non-integers', () => {
    expect(() => tokensToMicros(1.5, 10)).toThrow();
    expect(() => tokensToMicros(10, -1)).toThrow();
  });

  it('prices turns and embeddings with the card', () => {
    expect(
      turnCost({ aiTextPer1kTokensMicros: 200_000 }, { inputTokens: 800, outputTokens: 200 }),
    ).toBe(200_000);
    expect(embedCost({ embeddingPer1kTokensMicros: 10_000 }, 2500)).toBe(25_000);
  });
});
