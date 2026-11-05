import type { Redis } from 'ioredis';

import {
  VoiceApiError,
  type VoiceApiClient,
  type VoiceDetailsPage,
  type VoiceIvr,
  type VoiceResultEvent,
  type VoiceResultRow,
  type VoiceSubmitInput,
  type VoiceSubmitResult,
} from './types';

/**
 * Fake Cell24x7 for dev / tests / E2E (refused in production). Results by the last digit:
 * 0–5 ANSWERED, 6–7 NO ANSWER, 8 BUSY, 9 FAILED, after `delayMs`. State lives in Redis so
 * every process sees it; results reach the app through the real result handler (`onResult`)
 * and through `details` (the poller), like the real provider.
 */

export type FakeVoiceFailure = '400' | '401' | '402' | '404' | 'timeout';

interface FakeRequest {
  numbers: string[];
  createdAt: number;
  durationSec: number;
}

const TTL_SEC = 2 * 24 * 3600;
const LIMIT = 100;

export const FAKE_VOICE_IVRS: VoiceIvr[] = [
  { id: 101, name: 'Fake IVR — press 1 to confirm', runnable: true },
  { id: 102, name: 'Fake IVR — draft', runnable: false },
];

/** Final status of a fake number (by its last digit). */
export const fakeVoiceStatus = (receiver: string): string => {
  const d = Number(receiver.slice(-1));
  if (d <= 5) return 'ANSWERED';
  if (d <= 7) return 'NO ANSWER';
  return d === 8 ? 'BUSY' : 'FAILED';
};

export class FakeVoiceClient implements VoiceApiClient {
  readonly provider = 'fake' as const;
  private failures: FakeVoiceFailure[] = [];
  private resultFn: ((event: VoiceResultEvent) => Promise<void>) | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Every submit this process made (tests). */
  readonly submits: VoiceSubmitInput[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly options: { delayMs: number; prefix?: string; now?: () => number } = {
      delayMs: 2000,
    },
  ) {}

  private key(part: string): string {
    return `${this.options.prefix ?? ''}vapi-fake:${part}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The next request fails this way (tests / E2E knobs). */
  failNext(kind: FakeVoiceFailure): void {
    this.failures.push(kind);
  }

  /** Where fake results are delivered (the same handler as the webhook route). */
  onResult(fn: (event: VoiceResultEvent) => Promise<void>): void {
    this.resultFn = fn;
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private fail(): void {
    const kind = this.failures.shift();
    if (!kind) return;
    if (kind === 'timeout') throw new VoiceApiError('VOICE_API_UNAVAILABLE', 0, true, 'no answer');
    if (kind === '401') throw new VoiceApiError('VOICE_API_AUTH', 401, false, 'Invalid API token');
    if (kind === '402')
      throw new VoiceApiError('VOICE_API_NO_CREDITS', 402, false, 'Not enough credits');
    if (kind === '404') throw new VoiceApiError('VOICE_API_NOT_FOUND', 404, false, 'Not found');
    throw new VoiceApiError('VOICE_API_REJECTED', 400, false, 'Invalid field');
  }

  private row(receiver: string, req: FakeRequest, final: boolean): VoiceResultRow {
    const status = final ? fakeVoiceStatus(receiver) : 'CALLING';
    return {
      receiver,
      status,
      durationSec: status === 'ANSWERED' ? req.durationSec : 0,
      retryCount: 0,
      dtmf: null,
      ivrDisposition: null,
    };
  }

  async submit(input: VoiceSubmitInput): Promise<VoiceSubmitResult> {
    this.fail();
    if (input.audio.kind === 'audio_id') {
      const known = await this.redis.sismember(this.key('audios'), String(input.audio.id));
      if (!known) throw new VoiceApiError('VOICE_API_NOT_FOUND', 404, false, 'Audio not found');
    }
    const audio = input.audio;
    if (audio.kind === 'ivr' && !FAKE_VOICE_IVRS.some((i) => i.id === audio.id)) {
      throw new VoiceApiError('VOICE_API_NOT_FOUND', 404, false, 'IVR not found');
    }
    let audioFileId: number | null = null;
    if (input.audio.kind === 'file') {
      audioFileId = await this.redis.incr(this.key('audio-seq'));
      await this.redis.sadd(this.key('audios'), String(audioFileId));
    } else if (input.audio.kind === 'audio_id') audioFileId = input.audio.id;
    const seq = await this.redis.incr(this.key('seq'));
    const requestId = `VCAMP_FAKE_${String(seq).padStart(6, '0')}`;
    const numbers = [...new Set(input.numbers)];
    const req: FakeRequest = { numbers, createdAt: this.now(), durationSec: 20 };
    await this.redis.set(this.key(`req:${requestId}`), JSON.stringify(req), 'EX', TTL_SEC);
    this.submits.push(input);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const fn = this.resultFn;
      if (!fn) return;
      void (async () => {
        for (const receiver of numbers) {
          await fn({ requestId, ...this.row(receiver, req, true) }).catch(() => undefined);
        }
      })();
    }, this.options.delayMs);
    timer.unref();
    this.timers.add(timer);
    return {
      requestId,
      contacts: numbers.length,
      creditsDeducted: numbers.length * 2,
      audioFileId: input.audio.kind === 'ivr' ? null : audioFileId,
    };
  }

  async details(requestId: string, page: number): Promise<VoiceDetailsPage> {
    this.fail();
    const text = await this.redis.get(this.key(`req:${requestId}`));
    if (!text) throw new VoiceApiError('VOICE_API_NOT_FOUND', 404, false, 'Unknown request');
    const req = JSON.parse(text) as FakeRequest;
    const final = this.now() >= req.createdAt + this.options.delayMs;
    const slice = req.numbers.slice((page - 1) * LIMIT, page * LIMIT);
    return {
      rows: slice.map((receiver) => this.row(receiver, req, final)),
      hasMore: page * LIMIT < req.numbers.length,
    };
  }

  ivrs(): Promise<VoiceIvr[]> {
    this.fail();
    return Promise.resolve(FAKE_VOICE_IVRS.map((i) => ({ ...i })));
  }

  async setWebhook(url: string): Promise<void> {
    this.fail();
    await this.redis.set(this.key('webhook'), url);
  }

  async getWebhook(): Promise<string | null> {
    this.fail();
    return this.redis.get(this.key('webhook'));
  }
}
