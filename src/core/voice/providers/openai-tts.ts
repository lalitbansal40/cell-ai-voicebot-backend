import { fromBytes } from '../audio/pcm';

import type { FetchLike, TtsProvider, TtsRequest } from './types';

export const TTS_TIMEOUT_MS = 15_000;

const LANGUAGE_NOTE: Record<string, string> = {
  hi: 'Speak in natural Hindi.',
  en: 'Speak in clear Indian English.',
  hinglish: 'Speak in natural Hinglish (Hindi and English mixed), Indian accent.',
};

export class TtsError extends Error {
  constructor(readonly code: string) {
    super(`Text-to-speech failed: ${code}`);
    this.name = 'TtsError';
  }
}

/** OpenAI `/audio/speech` → PCM16 24 kHz (one retry on 5xx / network). */
export class OpenAiTts implements TtsProvider {
  readonly name = 'openai' as const;

  constructor(
    private readonly deps: { apiKey: string; baseUrl: string; model: string; fetch: FetchLike },
  ) {}

  get model(): string {
    return this.deps.model;
  }

  async synthesize(request: TtsRequest): Promise<Int16Array> {
    const body = JSON.stringify({
      model: this.deps.model,
      voice: request.voice,
      input: request.text,
      instructions: [LANGUAGE_NOTE[request.language] ?? '', request.tone ?? ''].join(' ').trim(),
      response_format: 'pcm',
    });
    for (let attempt = 1; ; attempt += 1) {
      let status = 0;
      try {
        const res = await this.deps.fetch(`${this.deps.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.deps.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        status = res.status;
        if (res.ok) return fromBytes(new Uint8Array(await res.arrayBuffer()));
      } catch {
        status = 0;
      }
      const retryable = status === 0 || status >= 500;
      if (!retryable || attempt >= 2)
        throw new TtsError(status ? `http_${String(status)}` : 'network');
    }
  }
}
