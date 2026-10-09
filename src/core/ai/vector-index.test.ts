import { describe, expect, it, vi } from 'vitest';

import { normalizeVector } from './embed';
import { createMemoryVectorIndex, KEYWORD_BOOST, keywordOf, type KbSnapshot } from './vector-index';

const snapshot = (
  version: number,
  rows: { id: string; text: string; v: number[] }[],
): KbSnapshot => ({
  version,
  ids: rows.map((r) => r.id),
  sourceIds: rows.map(() => 's1'),
  titles: rows.map((r) => `T-${r.id}`),
  texts: rows.map((r) => r.text),
  dims: 3,
  vectors: Float32Array.from(rows.flatMap((r) => normalizeVector(r.v))),
});

const ROWS = [
  { id: 'a', text: 'payment methods upi', v: [1, 0, 0] },
  { id: 'b', text: 'late fee rules', v: [0.8, 0.6, 0] },
  { id: 'c', text: 'office address', v: [0, 0, 1] },
];

describe('memory vector index', () => {
  it('ranks by cosine, filters by minScore, ties by id', async () => {
    const index = createMemoryVectorIndex(() => Promise.resolve(snapshot(1, ROWS)));
    const hits = await index.search([{ kbId: 'kb', version: 1 }], [1, 0, 0], {
      topK: 5,
      minScore: 0.5,
    });
    expect(hits.map((h) => [h.chunkId, h.score])).toEqual([
      ['a', 1],
      ['b', 0.8],
    ]);
    expect(hits[0]).toMatchObject({ kbId: 'kb', sourceId: 's1', title: 'T-a' });
    const ties = createMemoryVectorIndex(() =>
      Promise.resolve(
        snapshot(1, [
          { id: 'z', text: '', v: [1, 0, 0] },
          { id: 'y', text: '', v: [1, 0, 0] },
        ]),
      ),
    );
    expect(
      (await ties.search([{ kbId: 'k', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 }))[0]
        ?.chunkId,
    ).toBe('y');
  });

  it('adds the keyword boost for the longest query word (≥ 5 chars)', async () => {
    expect(keywordOf('what is the late fee amount')).toBe('amount');
    expect(keywordOf('a b cd')).toBeNull();
    const index = createMemoryVectorIndex(() => Promise.resolve(snapshot(1, ROWS)));
    const hits = await index.search([{ kbId: 'kb', version: 1 }], [0, 0, 1], {
      topK: 3,
      minScore: 0,
      queryText: 'tell me about payment',
    });
    expect(hits.find((h) => h.chunkId === 'a')?.score).toBe(KEYWORD_BOOST);
  });

  it('caches per version, reloads on a bump, evicts by bytes (LRU)', async () => {
    const loader = vi.fn((kbId: string) => Promise.resolve(snapshot(kbId === 'kb2' ? 1 : 1, ROWS)));
    const index = createMemoryVectorIndex(loader);
    await index.search([{ kbId: 'kb', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 });
    await index.search([{ kbId: 'kb', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 });
    expect(loader).toHaveBeenCalledTimes(1);
    await index.search([{ kbId: 'kb', version: 2 }], [1, 0, 0], { topK: 1, minScore: 0 });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(index.cachedBytes).toBeGreaterThan(0);
    index.invalidate('kb');
    expect(index.cachedBytes).toBe(0);

    const one = index.cachedBytes;
    const small = createMemoryVectorIndex(loader, 500);
    await small.search([{ kbId: 'kb', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 });
    const size = small.cachedBytes;
    expect(size).toBeGreaterThan(one);
    await small.search([{ kbId: 'kb2', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 });
    expect(small.cachedBytes).toBe(size); // kb evicted for kb2
    await small.search([{ kbId: 'kb', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 });
    expect(loader).toHaveBeenCalledTimes(5);
    const tiny = createMemoryVectorIndex(loader, 10); // too big to cache at all
    await tiny.search([{ kbId: 'kb', version: 1 }], [1, 0, 0], { topK: 1, minScore: 0 });
    expect(tiny.cachedBytes).toBe(0);
    small.invalidate();
    expect(small.cachedBytes).toBe(0);
  });

  it('skips snapshots with other dimensions', async () => {
    const index = createMemoryVectorIndex(() => Promise.resolve(snapshot(1, ROWS)));
    expect(
      await index.search([{ kbId: 'kb', version: 1 }], [1, 0], { topK: 3, minScore: 0 }),
    ).toEqual([]);
  });
});
