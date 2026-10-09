import { Types } from 'mongoose';

import { AI_LIMITS } from '../../config/limits';
import { KnowledgeBaseModel } from '../../db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../db/models/knowledge-chunk.model';
import { KnowledgeSourceModel } from '../../db/models/knowledge-source.model';

import { embedTexts } from './embed';
import type { AiProvider } from './types';
import {
  createMemoryVectorIndex,
  type KbSnapshot,
  type VectorHit,
  type VectorIndex,
} from './vector-index';

/** Live chunks of a knowledge base: each source's current version only. */
export const loadKbSnapshot = async (kbId: string): Promise<KbSnapshot> => {
  const _id = new Types.ObjectId(kbId);
  const kb = await KnowledgeBaseModel.findById(_id)
    .select({ version: 1 })
    .lean<{ version: number }>();
  const sources = await KnowledgeSourceModel.find({ kbId: _id, chunks: { $gt: 0 } })
    .select({ version: 1 })
    .lean<{ _id: Types.ObjectId; version: number }[]>();
  const rows = sources.length
    ? await KnowledgeChunkModel.find({
        kbId: _id,
        $or: sources.map((s) => ({ sourceId: s._id, sourceVersion: s.version })),
      })
        .select({ sourceId: 1, title: 1, text: 1, embedding: 1, dims: 1 })
        .sort({ sourceId: 1, order: 1 })
        .lean<
          {
            _id: Types.ObjectId;
            sourceId: Types.ObjectId;
            title: string;
            text: string;
            embedding: number[];
            dims: number;
          }[]
        >()
    : [];
  const dims = rows[0]?.dims ?? AI_LIMITS.embeddingDims;
  const usable = rows.filter((r) => r.dims === dims && r.embedding.length === dims);
  const vectors = new Float32Array(usable.length * dims);
  usable.forEach((r, i) => vectors.set(r.embedding, i * dims));
  return {
    version: kb?.version ?? 0,
    ids: usable.map((r) => r._id.toString()),
    sourceIds: usable.map((r) => r.sourceId.toString()),
    titles: usable.map((r) => r.title),
    texts: usable.map((r) => r.text),
    dims,
    vectors,
  };
};

let shared: VectorIndex | null = null;

/** The process-wide index (one cache per API / worker process). */
export const knowledgeIndex = (): VectorIndex =>
  (shared ??= createMemoryVectorIndex(loadKbSnapshot));

export interface KnowledgeSearch {
  hits: VectorHit[];
  /** Tokens used to embed the query (part of a turn's cost in the runtime). */
  embeddingTokens: number;
}

/**
 * `searchKnowledgeBases(kbIds, query, { topK, minScore })` — only knowledge
 * bases of the account; results ordered by score (deterministic ties).
 */
export const searchKnowledgeBases = async (
  accountId: Types.ObjectId,
  kbIds: Types.ObjectId[],
  query: string,
  options: { topK: number; minScore: number },
  deps: { provider: Pick<AiProvider, 'embed'>; model: string; index?: VectorIndex },
): Promise<KnowledgeSearch> => {
  const text = query.trim();
  if (!text || !kbIds.length) return { hits: [], embeddingTokens: 0 };
  const kbs = await KnowledgeBaseModel.find({ accountId, _id: { $in: kbIds } })
    .select({ version: 1 })
    .lean<{ _id: Types.ObjectId; version: number }[]>();
  if (!kbs.length) return { hits: [], embeddingTokens: 0 };
  const { vectors, tokens } = await embedTexts(deps.provider, deps.model, [text]);
  const hits = await (deps.index ?? knowledgeIndex()).search(
    kbs.map((kb) => ({ kbId: kb._id.toString(), version: kb.version })),
    vectors[0] ?? [],
    { ...options, queryText: text },
  );
  return { hits, embeddingTokens: tokens };
};
