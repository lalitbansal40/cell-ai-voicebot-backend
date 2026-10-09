/**
 * DEV ONLY — Phase 5 knowledge search timing (PHASE_5_PROMPT T5.9).
 *   npm run bench:retrieval               (3 knowledge bases × 2,000 chunks, 200 searches)
 *   npm run bench:retrieval -- 2000 200
 * Creates a throw-away account `bench-<ts>` with 3 knowledge bases of
 * deterministic fake-embedded chunks (1,536 dims), then searches all three at
 * once — one cold run (loads + caches the vectors) and N warm runs — and
 * prints p50 / p95 / p99, cache bytes and memory. Deletes everything it made.
 * Needs `npm run infra:up`. Refuses NODE_ENV=production.
 */
import type { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { fakeEmbedding } from '../src/core/ai';
import { loadKbSnapshot } from '../src/core/ai/retrieve';
import { createMemoryVectorIndex } from '../src/core/ai/vector-index';
import { AccountModel } from '../src/db/models/account.model';
import { KnowledgeBaseModel } from '../src/db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../src/db/models/knowledge-chunk.model';
import { KnowledgeSourceModel } from '../src/db/models/knowledge-source.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { createLogger } from '../src/shared/logger';

const BENCH_PREFIX = 'bench-';
const KBS = 3;
const WORDS = [
  'emi',
  'late',
  'fee',
  'upi',
  'branch',
  'policy',
  'grace',
  'loan',
  'auto',
  'debit',
  'receipt',
  'interest',
  'tenure',
  'foreclosure',
  'promise',
  'payment',
  'support',
  'hours',
  'charge',
  'refund',
];

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const text = (i: number) =>
  Array.from({ length: 60 }, (_, w) => WORDS[(i * 7 + w * 3) % WORDS.length]).join(' ');

/** Removes the throw-away account's knowledge data (bench accounts only). */
const cleanup = async (accountId: Types.ObjectId): Promise<void> => {
  const account = await AccountModel.findById(accountId).lean();
  if (!account?.slug.startsWith(BENCH_PREFIX))
    throw new Error('refusing to delete a non-bench account');
  await KnowledgeChunkModel.deleteMany({ accountId });
  await KnowledgeSourceModel.deleteMany({ accountId });
  await KnowledgeBaseModel.deleteMany({ accountId });
  await AccountModel.deleteOne({ _id: accountId });
};

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('bench:retrieval is disabled in production');
  const chunksPerKb = Number(process.argv[2] ?? 2000);
  const searches = Number(process.argv[3] ?? 200);
  if (
    !Number.isSafeInteger(chunksPerKb) ||
    chunksPerKb < 1 ||
    !Number.isSafeInteger(searches) ||
    searches < 1
  ) {
    throw new Error('Usage: npm run bench:retrieval -- [chunksPerKb] [searches]');
  }
  await connectMongo(env, createLogger({ ...env, LOG_LEVEL: 'warn' }));
  const account = await AccountModel.create({
    name: 'Retrieval bench',
    slug: `${BENCH_PREFIX}${Date.now()}`,
  });
  const accountId = account._id;
  try {
    const kbs: { kbId: string; version: number }[] = [];
    const seedStart = performance.now();
    for (let k = 0; k < KBS; k += 1) {
      const kb = await KnowledgeBaseModel.create({
        accountId,
        name: `Bench KB ${k + 1}`,
        version: 1,
      });
      const source = await KnowledgeSourceModel.create({
        accountId,
        kbId: kb._id,
        kind: 'url',
        title: `bench-${k}`,
        url: 'https://bench.example',
        status: 'ready',
        chunks: chunksPerKb,
        version: 1,
      });
      for (let start = 0; start < chunksPerKb; start += 500) {
        const rows = Array.from({ length: Math.min(500, chunksPerKb - start) }, (_, j) => {
          const i = k * chunksPerKb + start + j;
          return {
            accountId,
            kbId: kb._id,
            sourceId: source._id,
            sourceVersion: 1,
            order: start + j,
            title: `Chunk ${i}`,
            text: text(i),
            embedding: fakeEmbedding(text(i)),
            dims: 1536,
            model: 'fake',
          };
        });
        await KnowledgeChunkModel.insertMany(rows, { lean: true });
      }
      kbs.push({ kbId: kb._id.toString(), version: 1 });
    }
    const seedMs = performance.now() - seedStart;

    const index = createMemoryVectorIndex(loadKbSnapshot);
    const query = (i: number) =>
      `${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} kitni hai?`;
    const options = (i: number) => ({ topK: 4, minScore: 0.2, queryText: query(i) });
    const coldStart = performance.now();
    await index.search(kbs, fakeEmbedding(query(0)), options(0));
    const coldMs = performance.now() - coldStart;
    const times: number[] = [];
    for (let i = 1; i <= searches; i += 1) {
      const vector = fakeEmbedding(query(i));
      const t0 = performance.now();
      await index.search(kbs, vector, options(i));
      times.push(performance.now() - t0);
    }
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    const ms = (n: number) => `${n.toFixed(2)} ms`;
    console.info(
      `Retrieval bench — ${KBS} knowledge bases × ${chunksPerKb} chunks = ${KBS * chunksPerKb} chunks (1,536 dims), ${searches} warm searches`,
    );
    console.info(`  seed (insert chunks): ${(seedMs / 1000).toFixed(1)} s`);
    console.info(`  cold search (load 3 bases + search): ${ms(coldMs)}`);
    console.info(
      `  warm search p50 ${ms(percentile(times, 50))} · p95 ${ms(percentile(times, 95))} · p99 ${ms(percentile(times, 99))}`,
    );
    console.info(
      `  vector cache: ${mb(index.cachedBytes)} · process RSS ${mb(process.memoryUsage().rss)}`,
    );
  } finally {
    await cleanup(accountId);
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
