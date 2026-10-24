import { describe, expect, it } from 'vitest';

import {
  createOpusCodec,
  OPUS_FRAME_SAMPLES,
  OPUS_RATE,
} from '../../src/core/telephony/whatsapp/codec';
import { hasTone } from '../../src/core/telephony/whatsapp/tones';
import { tone } from '../../src/core/voice/audio/pcm';

/** Encodes + decodes `ms` of a tone through `codec` → decoded PCM. */
const roundTrip = (codec: ReturnType<typeof createOpusCodec>, ms: number, hz: number) => {
  const input = tone(ms, OPUS_RATE, { hz, amplitude: 8_000 });
  const out = new Int16Array(input.length);
  for (let i = 0; i + OPUS_FRAME_SAMPLES <= input.length; i += OPUS_FRAME_SAMPLES) {
    out.set(codec.decode(codec.encode(input.subarray(i, i + OPUS_FRAME_SAMPLES))), i);
  }
  return out;
};

describe('Opus codec with many calls alive (WASM heap growth)', () => {
  it('an older codec keeps working after new codecs grow the heap', () => {
    const first = createOpusCodec();
    expect(hasTone(roundTrip(first, 400, 1_000).subarray(4_800), OPUS_RATE, 1_000, 440)).toBe(true);
    // enough codecs to grow the WASM memory several times (≈ 3 per call, 100+ calls)
    const many = Array.from({ length: 400 }, () => createOpusCodec());
    for (const c of many.slice(-5)) roundTrip(c, 100, 440);
    const again = roundTrip(first, 400, 1_000);
    expect(hasTone(again.subarray(4_800), OPUS_RATE, 1_000, 440)).toBe(true);
    // the newest codec is not disturbed by the older one either
    const last = many.at(-1);
    expect(last && hasTone(roundTrip(last, 400, 440).subarray(4_800), OPUS_RATE, 440, 1_000)).toBe(
      true,
    );
    for (const c of many) c.destroy();
    first.destroy();
  });

  it('refuses use after destroy and oversized packets', () => {
    const c = createOpusCodec();
    expect(() => c.decode(Buffer.alloc(4_000, 1))).toThrow(RangeError);
    c.destroy();
    expect(() => c.encode(new Int16Array(OPUS_FRAME_SAMPLES))).toThrow('used after destroy');
    expect(() => c.decode(Buffer.from([1, 2, 3]))).toThrow('used after destroy');
  });
});
