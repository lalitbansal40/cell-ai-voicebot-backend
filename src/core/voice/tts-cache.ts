import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import { CALL_LIMITS } from '../../config/limits';
import { TtsCacheModel } from '../../db/models/tts-cache.model';
import { assertSafeKey, type StorageProvider } from '../storage';

import { durationMs, fromBytes, toBytes } from './audio/pcm';
import type { TtsProvider, TtsRequest } from './providers/types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const ttsCacheKey = (model: string, request: TtsRequest): string =>
  createHash('sha256')
    .update(
      JSON.stringify([model, request.voice, request.language, request.tone ?? '', request.text]),
    )
    .digest('hex');

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

/**
 * Spoken lines are synthesised once per (model, voice, language, tone, text)
 * and kept as PCM16 24 kHz in storage; concurrent requests share one synthesis.
 */
export class TtsCache {
  private readonly inflight = new Map<string, Promise<{ pcm: Int16Array; cached: boolean }>>();

  constructor(
    private readonly deps: { tts: TtsProvider; storage: StorageProvider; now?: () => Date },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async get(request: TtsRequest): Promise<{ pcm: Int16Array; cached: boolean }> {
    const key = ttsCacheKey(this.deps.tts.model, request);
    const pending = this.inflight.get(key);
    if (pending) return { pcm: (await pending).pcm, cached: true };
    // registered before any await, so concurrent callers share the lookup and the synthesis
    const work = this.load(key, request);
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async load(
    key: string,
    request: TtsRequest,
  ): Promise<{ pcm: Int16Array; cached: boolean }> {
    const stored = await TtsCacheModel.findOneAndUpdate(
      { key },
      { $inc: { hits: 1 }, $set: { lastUsedAt: this.now() } },
      { returnDocument: 'after' },
    ).lean();
    if (stored && (await this.deps.storage.exists(stored.fileKey))) {
      return {
        pcm: fromBytes(await readAll(await this.deps.storage.get(stored.fileKey))),
        cached: true,
      };
    }
    return { pcm: await this.create(key, request), cached: false };
  }

  /** Removes entries unused for `ttsCacheUnusedDays` with their audio files. */
  async purge(): Promise<{ entries: number }> {
    const cutoff = new Date(this.now().getTime() - CALL_LIMITS.ttsCacheUnusedDays * DAY_MS);
    const old = await TtsCacheModel.find({ lastUsedAt: { $lt: cutoff } })
      .select({ fileKey: 1 })
      .lean();
    for (const entry of old) {
      await this.deps.storage.delete(entry.fileKey);
      await TtsCacheModel.deleteOne({ _id: entry._id });
    }
    return { entries: old.length };
  }

  private async create(key: string, request: TtsRequest): Promise<Int16Array> {
    const pcm = await this.deps.tts.synthesize(request);
    const fileKey = assertSafeKey(`tts-cache/${key}.pcm`);
    await this.deps.storage.put(fileKey, toBytes(pcm), { contentType: 'application/octet-stream' });
    const now = this.now();
    await TtsCacheModel.updateOne(
      { key },
      {
        $set: {
          model: this.deps.tts.model,
          voice: request.voice,
          language: request.language,
          chars: request.text.length,
          fileKey,
          durationMs: durationMs(pcm.length, 24_000),
          lastUsedAt: now,
        },
        $setOnInsert: { key, hits: 0 },
      },
      { upsert: true },
    );
    return pcm;
  }
}
