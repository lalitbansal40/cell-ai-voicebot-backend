import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { AI_LIMITS } from '../../config/limits';
import { chunkText, DEFAULT_CHUNK_OPTIONS } from '../../core/ai/chunker';
import { embedTexts } from '../../core/ai/embed';
import { fetchPage, type HttpToolOptions } from '../../core/ai/http-tool';
import { outgoingPolicy } from '../../core/ai/ip-guard';
import type { AiJobData, AiJobs } from '../../core/ai/jobs';
import {
  normalizeText,
  ParseError,
  parseHtml,
  parseKnowledgeFile,
  decodeText,
} from '../../core/ai/parsers';
import { embedCost } from '../../core/ai/pricing';
import type { AiProvider } from '../../core/ai/types';
import { chargeUsage } from '../../core/billing/engine';
import { effectiveRateCard } from '../../core/billing/rates';
import { getAppRedis } from '../../core/queues/redis';
import type { StorageProvider } from '../../core/storage';
import { KnowledgeBaseModel } from '../../db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../db/models/knowledge-chunk.model';
import {
  KnowledgeSourceModel,
  type KnowledgeSourceDoc,
  type KnowledgeSourceStatus,
} from '../../db/models/knowledge-source.model';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import { notifySource, refreshKbCounts, requeueSources } from './knowledge.service';

export interface IngestContext {
  provider?: Pick<AiProvider, 'embed'>;
  storage?: StorageProvider;
  jobs: AiJobs;
  /** Tests: fake resolver / dial / ports for URL sources. */
  http?: Omit<HttpToolOptions, 'policy'> & { extraPorts?: number[] };
  /** Attempt number (1-based) and the job's max attempts — provider errors retry. */
  attempt?: { made: number; max: number };
  /** Progress throttle (ms) — tests use 0. */
  throttleMs?: number;
}

export const URL_TIMEOUT_MS = 15_000;
const LOCK_TTL_MS = 10 * 60_000;
const LOCK_WAIT_MS = 5 * 60_000;

export const INGEST_MESSAGES = {
  wallet: 'Add money to process this document.',
  budget: 'The monthly AI budget is used up. Raise it or wait for next month.',
  provider: 'The AI service is not available right now. Try again later.',
  missingFile: 'The uploaded file is missing. Upload it again.',
  tooManyChunks: `This knowledge base is full (${AI_LIMITS.chunksPerKb} pieces). Remove a source first.`,
  noText: 'No text found.',
  unexpected: 'Something went wrong while processing this source. Try again.',
} as const;

const redis = () => getAppRedis(getEnv().REDIS_URL, getLogger());
const lockKey = (kbId: string) => `kb:ingest-lock:${kbId}`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One ingest per knowledge base at a time (waits for the lock, ≤ 5 min). */
export const withKbLock = async <T>(kbId: string, fn: () => Promise<T>): Promise<T> => {
  const owner = randomUUID();
  const until = Date.now() + LOCK_WAIT_MS;
  while ((await redis().set(lockKey(kbId), owner, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') {
    if (Date.now() > until) throw new Error('Knowledge base is busy');
    await sleep(250);
  }
  try {
    return await fn();
  } finally {
    await redis().eval(RELEASE, 1, lockKey(kbId), owner);
  }
};

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
};

class IngestFailure extends Error {}

/** Text of a source: stored file → parser; URL → guarded fetch → HTML / text. */
const sourceText = async (
  source: KnowledgeSourceDoc,
  ctx: IngestContext,
): Promise<{ text: string; title?: string; bytes?: number }> => {
  if (source.kind === 'file') {
    if (!ctx.storage || !source.fileKey || !source.fileType)
      throw new IngestFailure(INGEST_MESSAGES.missingFile);
    let buffer: Buffer;
    try {
      buffer = await readAll(await ctx.storage.get(source.fileKey));
    } catch {
      throw new IngestFailure(INGEST_MESSAGES.missingFile);
    }
    return { text: await parseKnowledgeFile(source.fileType, buffer) };
  }
  const page = await fetchPage(
    source.url ?? '',
    { ...ctx.http, policy: outgoingPolicy(getEnv(), ctx.http?.extraPorts) },
    { maxBytes: AI_LIMITS.urlMaxBytes, timeoutMs: URL_TIMEOUT_MS },
  );
  if (!page.ok) {
    const reason =
      page.error === 'blocked'
        ? 'This address is not allowed.'
        : page.error === 'too_large'
          ? 'The page is larger than 2 MB.'
          : page.error === 'unsupported_type'
            ? 'Only web pages (HTML) and plain text can be added.'
            : page.error === 'timeout'
              ? 'The page took too long to load.'
              : `The page could not be loaded (${page.error ?? 'error'}).`;
    throw new IngestFailure(reason);
  }
  const raw = decodeText(page.body);
  if (page.contentType.startsWith('text/html')) {
    const html = parseHtml(raw);
    return {
      text: normalizeText(html.text),
      ...(html.title ? { title: html.title } : {}),
      bytes: page.body.length,
    };
  }
  return { text: normalizeText(raw), bytes: page.body.length };
};

/**
 * `kb.ingest` (PHASE_5_PROMPT T5.5): parse → chunk → embed → charge → swap
 * chunks → ready. Stale jobs (source deleted / re-queued since) do nothing.
 * Parse problems fail at once; provider errors retry until the last attempt.
 */
export const ingestSource = async (
  data: AiJobData['kb.ingest'],
  ctx: IngestContext,
): Promise<{ status: KnowledgeSourceStatus | 'skipped'; chunks?: number }> => {
  const accountId = new Types.ObjectId(data.accountId);
  const sourceId = new Types.ObjectId(data.sourceId);
  const current = await KnowledgeSourceModel.findOne({
    _id: sourceId,
    accountId,
  }).lean<KnowledgeSourceDoc>();
  if (!current || current.version !== data.version) return { status: 'skipped' };

  return withKbLock(data.kbId, async () => {
    const env = getEnv();
    const model = env.OPENAI_EMBEDDING_MODEL;
    let lastAt = 0;
    const update = async (
      set: Partial<
        Pick<
          KnowledgeSourceDoc,
          | 'status'
          | 'progress'
          | 'error'
          | 'chars'
          | 'chunks'
          | 'title'
          | 'bytes'
          | 'embeddingModel'
        >
      >,
      force = false,
    ): Promise<boolean> => {
      const next = await KnowledgeSourceModel.findOneAndUpdate(
        { _id: sourceId, accountId, version: data.version },
        { $set: set },
        { returnDocument: 'after' },
      ).lean<KnowledgeSourceDoc>();
      if (!next) return false; // deleted or re-queued meanwhile
      const now = Date.now();
      if (force || now - lastAt >= (ctx.throttleMs ?? 1000)) {
        lastAt = now;
        notifySource(next);
      }
      return true;
    };
    const fail = async (message: string) => {
      await KnowledgeChunkModel.deleteMany({ sourceId, accountId });
      await update(
        { status: 'failed', progress: 100, error: message.slice(0, 300), chunks: 0 },
        true,
      );
      await refreshKbCounts(current.kbId);
      return { status: 'failed' as const };
    };

    if (!(await update({ status: 'processing', progress: 5, error: null }, true)))
      return { status: 'skipped' };
    try {
      const { text, title, bytes } = await sourceText(current, ctx);
      if (!text) return await fail(INGEST_MESSAGES.noText);
      const pieces = chunkText(text, {
        ...DEFAULT_CHUNK_OPTIONS,
        fallbackTitle: title ?? current.title,
      });
      const others = await KnowledgeSourceModel.aggregate<{ chunks: number }>([
        { $match: { kbId: current.kbId, accountId, _id: { $ne: sourceId } } },
        { $group: { _id: null, chunks: { $sum: '$chunks' } } },
      ]);
      if ((others[0]?.chunks ?? 0) + pieces.length > AI_LIMITS.chunksPerKb) {
        return await fail(INGEST_MESSAGES.tooManyChunks);
      }
      await update({
        progress: 30,
        chars: text.length,
        ...(bytes ? { bytes } : {}),
        ...(current.kind === 'url' && title ? { title: title.slice(0, 200) } : {}),
      });

      if (!ctx.provider) throw new Error('AI provider is not configured for the worker');
      const { vectors, tokens } = await embedTexts(
        ctx.provider,
        model,
        pieces.map((p) => p.text),
        (done, total) =>
          update({ progress: 30 + Math.floor((done / total) * 50) }).then(() => undefined),
      );

      const cost = embedCost(await effectiveRateCard(accountId), tokens);
      if (cost > 0) {
        try {
          await chargeUsage({
            accountId,
            type: 'ai_charge',
            amountMicros: cost,
            breakdown: { aiMicros: cost, embeddingTokens: tokens, model, kind: 'kb_ingest' },
            ref: { type: 'usage', id: sourceId.toString() },
            idempotencyKey: `kbingest:${sourceId.toString()}:${data.version}`,
          });
        } catch (err) {
          if (err instanceof AppError && err.code === 'WALLET_INSUFFICIENT_BALANCE')
            return await fail(INGEST_MESSAGES.wallet);
          if (err instanceof AppError && err.code === 'WALLET_BUDGET_EXCEEDED')
            return await fail(INGEST_MESSAGES.budget);
          throw err;
        }
      }
      await update({ progress: 90 });

      // new version in, then every other version out — readers only see the source's current version
      await KnowledgeChunkModel.deleteMany({ sourceId, accountId, sourceVersion: data.version });
      await KnowledgeChunkModel.insertMany(
        pieces.map((p, i) => ({
          accountId,
          kbId: current.kbId,
          sourceId,
          sourceVersion: data.version,
          order: p.order,
          title: p.title.slice(0, 200),
          text: p.text,
          embedding: vectors[i] ?? [],
          dims: vectors[i]?.length ?? 0,
          model,
        })),
      );
      await KnowledgeChunkModel.deleteMany({
        sourceId,
        accountId,
        sourceVersion: { $ne: data.version },
      });
      const done = await update(
        {
          status: 'ready',
          progress: 100,
          error: null,
          chunks: pieces.length,
          embeddingModel: model,
        },
        true,
      );
      if (!done) {
        await KnowledgeChunkModel.deleteMany({ sourceId, accountId, sourceVersion: data.version });
        return { status: 'skipped' };
      }
      await KnowledgeBaseModel.updateOne(
        { _id: current.kbId, accountId },
        { $set: { embeddingModel: model } },
      );
      await refreshKbCounts(current.kbId);
      return { status: 'ready', chunks: pieces.length };
    } catch (err) {
      if (err instanceof ParseError || err instanceof IngestFailure) return await fail(err.message);
      const providerDown =
        err instanceof AppError &&
        (err.code === 'PROVIDER_UNAVAILABLE' || err.code === 'PROVIDER_ERROR');
      const lastAttempt = !ctx.attempt || ctx.attempt.made + 1 >= ctx.attempt.max;
      // the source never stays "processing": the last attempt always ends in failed
      if (lastAttempt) {
        getLogger().error({ err, sourceId: data.sourceId }, 'knowledge: ingest failed');
        return await fail(providerDown ? INGEST_MESSAGES.provider : INGEST_MESSAGES.unexpected);
      }
      await update({ status: 'queued', progress: 0 }, true);
      throw err;
    }
  });
};

/** `kb.reindex`: re-queues every source of a base. */
export const reindexKnowledgeBase = async (
  data: AiJobData['kb.reindex'],
  ctx: Pick<IngestContext, 'jobs'>,
): Promise<{ queued: number }> => {
  const sources = await requeueSources(
    new Types.ObjectId(data.kbId),
    new Types.ObjectId(data.accountId),
    ctx.jobs,
  );
  return { queued: sources.length };
};
