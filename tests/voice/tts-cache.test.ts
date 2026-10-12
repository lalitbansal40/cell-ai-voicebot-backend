import { describe, expect, it, vi } from 'vitest';

import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache, ttsCacheKey } from '../../src/core/voice/tts-cache';
import { TtsCacheModel } from '../../src/db/models/tts-cache.model';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';

useTestDb();
const storage = useTempStorage();
const REQ = { text: 'Namaste Asha', voice: 'coral', language: 'hinglish' };

describe('TtsCache', () => {
  it('synthesises once, then serves the stored copy and counts hits', async () => {
    const tts = new FakeTts();
    const spy = vi.spyOn(tts, 'synthesize');
    const cache = new TtsCache({ tts, storage, now: () => new Date('2026-10-12T00:00:00Z') });
    const first = await cache.get(REQ);
    expect(first.cached).toBe(false);
    const second = await cache.get(REQ);
    expect(second.cached).toBe(true);
    expect(Array.from(second.pcm)).toEqual(Array.from(first.pcm));
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = await TtsCacheModel.findOne({ key: ttsCacheKey('fake-tts', REQ) }).lean();
    expect(entry).toMatchObject({ hits: 1, chars: 12, voice: 'coral', language: 'hinglish' });
    expect(JSON.stringify(entry)).not.toContain('Namaste');
    // tone and model change the key
    expect(ttsCacheKey('fake-tts', { ...REQ, tone: 'calm' })).not.toBe(
      ttsCacheKey('fake-tts', REQ),
    );
    expect(ttsCacheKey('other', REQ)).not.toBe(ttsCacheKey('fake-tts', REQ));
  });

  it('concurrent requests share one synthesis; a missing file is made again', async () => {
    const tts = new FakeTts();
    const spy = vi.spyOn(tts, 'synthesize');
    const cache = new TtsCache({ tts, storage });
    const req = { ...REQ, text: 'Shared line' };
    const [a, b] = await Promise.all([cache.get(req), cache.get(req)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
    const entry = await TtsCacheModel.findOne({ key: ttsCacheKey('fake-tts', req) }).lean();
    await storage.delete(entry?.fileKey ?? '');
    expect((await cache.get(req)).cached).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('purges entries unused for 30 days with their files', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const cache = new TtsCache({ tts: new FakeTts(), storage, now: () => now });
    const req = { ...REQ, text: 'Old line' };
    await cache.get(req);
    const entry = await TtsCacheModel.findOne({ key: ttsCacheKey('fake-tts', req) }).lean();
    now = new Date('2026-01-20T00:00:00Z');
    expect(await cache.purge()).toEqual({ entries: 0 });
    now = new Date('2026-03-01T00:00:00Z');
    const purged = await cache.purge();
    expect(purged.entries).toBeGreaterThanOrEqual(1);
    expect(await storage.exists(entry?.fileKey ?? '')).toBe(false);
    expect(await TtsCacheModel.countDocuments({ key: entry?.key })).toBe(0);
    expect(await new TtsCache({ tts: new FakeTts(), storage }).purge()).toEqual({ entries: 0 });
  });
});
