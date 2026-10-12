import { describe, expect, it } from 'vitest';

import { Framer } from './framer';
import { tone } from './pcm';
import { Resampler } from './resample';

/** SNR (dB) of `actual` against an ideal tone, skipping `edge` samples at both ends. */
const snr = (actual: Int16Array, rate: number, hz: number, amplitude: number, edge: number) => {
  let signal = 0;
  let noise = 0;
  for (let i = edge; i < actual.length - edge; i += 1) {
    const ideal = Math.sin((2 * Math.PI * hz * i) / rate) * amplitude;
    signal += ideal * ideal;
    noise += ((actual[i] ?? 0) - ideal) ** 2;
  }
  return 10 * Math.log10(signal / noise);
};

const pure = (ms: number, rate: number) =>
  tone(ms, rate, { hz: 1000, amplitude: 10000, fadeMs: 0 });

describe('Resampler', () => {
  it('24 → 8 → 24 kHz keeps a 1 kHz tone (SNR ≥ 30 dB) and exact lengths', () => {
    const input = pure(500, 24000);
    const down = Resampler.convert(input, 24000, 8000);
    expect(down.length).toBe(4000);
    expect(snr(down, 8000, 1000, 10000, 100)).toBeGreaterThan(30);
    const up = Resampler.convert(down, 8000, 24000);
    expect(up.length).toBe(12000);
    expect(snr(up, 24000, 1000, 10000, 300)).toBeGreaterThan(30);
  });

  it('16 ↔ 24 kHz, and streaming 20 ms chunks equals one shot', () => {
    const input = pure(400, 16000);
    const whole = Resampler.convert(input, 16000, 24000);
    expect(whole.length).toBe(9600);
    expect(snr(whole, 24000, 1000, 10000, 300)).toBeGreaterThan(30);
    const r = new Resampler(16000, 24000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 320)
      parts.push(...r.process(input.subarray(i, i + 320)));
    parts.push(...r.flush());
    expect(parts).toEqual(Array.from(whole));
    expect(r.lookahead).toBeGreaterThan(0);
  });

  it('removes content above the new Nyquist (anti-aliasing)', () => {
    const high = tone(300, 24000, { hz: 9000, amplitude: 10000, fadeMs: 0 });
    const down = Resampler.convert(high, 24000, 8000);
    let peak = 0;
    for (let i = 100; i < down.length - 100; i += 1) peak = Math.max(peak, Math.abs(down[i] ?? 0));
    expect(peak).toBeLessThan(400);
  });

  it('same rate copies; bad rates throw; empty input is fine', () => {
    const same = new Resampler(8000, 8000);
    const pcm = Int16Array.from([1, 2, 3]);
    expect(Array.from(same.process(pcm))).toEqual([1, 2, 3]);
    expect(same.flush()).toHaveLength(0);
    expect(Array.from(Resampler.convert(pcm, 8000, 8000))).toEqual([1, 2, 3]);
    expect(() => new Resampler(0, 8000)).toThrow(RangeError);
    expect(() => new Resampler(8000, 1.5)).toThrow(RangeError);
    expect(new Resampler(24000, 8000).process(new Int16Array(0))).toHaveLength(0);
  });
});

describe('Framer', () => {
  it('cuts any chunk sizes into exact frames and pads the last one', () => {
    const f = new Framer(4);
    expect(f.push(Int16Array.from([1, 2, 3]))).toEqual([]);
    expect(f.buffered).toBe(3);
    const frames = f.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((x) => Array.from(x))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(Array.from(f.flush() ?? [])).toEqual([9, 0, 0, 0]);
    expect(f.flush()).toBeNull();
    expect(Framer.split(Int16Array.from([1, 2, 3, 4, 5]), 2)).toHaveLength(3);
    expect(Framer.split(Int16Array.from([1, 2]), 2)).toHaveLength(1);
    expect(() => new Framer(0)).toThrow(RangeError);
  });
});
