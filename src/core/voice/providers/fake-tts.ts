import { tone } from '../audio/pcm';

import type { TtsProvider, TtsRequest } from './types';

/** 60 ms of tone per character (0.3 s – 20 s) — deterministic length, audible, recordable. */
export const fakeTtsMs = (text: string): number =>
  Math.min(20_000, Math.max(300, text.length * 60));

export class FakeTts implements TtsProvider {
  readonly name = 'fake' as const;
  readonly model = 'fake-tts';
  /** Texts synthesised (tests). */
  readonly spoken: string[] = [];

  synthesize(request: TtsRequest): Promise<Int16Array> {
    this.spoken.push(request.text);
    return Promise.resolve(tone(fakeTtsMs(request.text), 24_000, { hz: 440, amplitude: 3277 }));
  }
}
