import { AI_LIMITS } from '../../config/limits';

/** One knowledge base's live chunks, as loaded for search. */
export interface KbSnapshot {
  version: number;
  ids: string[];
  sourceIds: string[];
  titles: string[];
  texts: string[];
  dims: number;
  /** n × dims, unit-length rows. */
  vectors: Float32Array;
}

export interface VectorHit {
  chunkId: string;
  kbId: string;
  sourceId: string;
  title: string;
  text: string;
  /** Cosine similarity (+ keyword boost), rounded to 4 decimals. */
  score: number;
}

export interface SearchOptions {
  topK: number;
  /** 0–1. */
  minScore: number;
  /** The query text, for the keyword boost. */
  queryText?: string;
}

/** Search over knowledge bases — swappable for MongoDB / a vector DB later (ADR 0033). */
export interface VectorIndex {
  search(
    kbs: { kbId: string; version: number }[],
    query: number[],
    options: SearchOptions,
  ): Promise<VectorHit[]>;
  /** Drops cached data (e.g. after a delete). */
  invalidate(kbId?: string): void;
  /** Bytes held by the cache (tests / metrics). */
  readonly cachedBytes: number;
}

export type KbLoader = (kbId: string) => Promise<KbSnapshot>;

export const KEYWORD_BOOST = 0.05;

const snapshotBytes = (s: KbSnapshot): number =>
  s.vectors.byteLength + s.texts.reduce((sum, t) => sum + t.length * 2, 0) + s.ids.length * 120;

/** Longest word (≥ 5 chars) of the query, lower-cased — the keyword boost term. */
export const keywordOf = (query: string): string | null => {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? [];
  return words.reduce<string | null>(
    (best, w) => (!best || w.length > best.length ? w : best),
    null,
  );
};

/**
 * In-process cosine search with an LRU cache (by bytes). A snapshot is
 * reused only while its knowledge base `version` is unchanged.
 */
export const createMemoryVectorIndex = (
  loader: KbLoader,
  maxBytes: number = AI_LIMITS.vectorCacheBytes,
): VectorIndex => {
  const cache = new Map<string, { snapshot: KbSnapshot; bytes: number }>();
  let total = 0;

  const drop = (kbId: string) => {
    const entry = cache.get(kbId);
    if (entry) total -= entry.bytes;
    cache.delete(kbId);
  };

  const get = async (kbId: string, version: number): Promise<KbSnapshot> => {
    const hit = cache.get(kbId);
    if (hit && hit.snapshot.version === version) {
      cache.delete(kbId); // most recently used goes last
      cache.set(kbId, hit);
      return hit.snapshot;
    }
    drop(kbId);
    const snapshot = await loader(kbId);
    const bytes = snapshotBytes(snapshot);
    if (bytes <= maxBytes) {
      while (total + bytes > maxBytes && cache.size) {
        const oldest = cache.keys().next().value as string;
        drop(oldest);
      }
      cache.set(kbId, { snapshot, bytes });
      total += bytes;
    }
    return snapshot;
  };

  return {
    get cachedBytes() {
      return total;
    },
    invalidate(kbId) {
      if (kbId) drop(kbId);
      else {
        cache.clear();
        total = 0;
      }
    },
    async search(kbs, query, options) {
      const keyword = options.queryText ? keywordOf(options.queryText) : null;
      const hits: VectorHit[] = [];
      for (const { kbId, version } of kbs) {
        const s = await get(kbId, version);
        if (s.dims !== query.length) continue;
        for (let row = 0; row < s.ids.length; row += 1) {
          let dot = 0;
          const offset = row * s.dims;
          for (let d = 0; d < s.dims; d += 1) dot += (s.vectors[offset + d] ?? 0) * (query[d] ?? 0);
          const text = s.texts[row] ?? '';
          if (keyword && text.toLowerCase().includes(keyword)) dot += KEYWORD_BOOST;
          const score = Math.round(dot * 10_000) / 10_000;
          if (score < options.minScore) continue;
          hits.push({
            chunkId: s.ids[row] ?? '',
            kbId,
            sourceId: s.sourceIds[row] ?? '',
            title: s.titles[row] ?? '',
            text,
            score,
          });
        }
      }
      // deterministic: score desc, then chunk id
      hits.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
      return hits.slice(0, options.topK);
    },
  };
};
