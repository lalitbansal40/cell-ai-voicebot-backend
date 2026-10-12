import { describe, expect, it } from 'vitest';

import {
  alawToLinear,
  decodeAlaw,
  decodeMulaw,
  encodeAlaw,
  encodeMulaw,
  linearToAlaw,
  linearToMulaw,
  mulawToLinear,
} from './g711';
import {
  clamp16,
  concat,
  dbfs,
  durationMs,
  fromBytes,
  rms,
  samplesFor,
  silence,
  toBytes,
  tone,
} from './pcm';

describe('pcm helpers', () => {
  it('bytes ⇄ samples (little-endian, odd byte ignored)', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const bytes = toBytes(pcm);
    expect(bytes.length).toBe(10);
    expect(Array.from(fromBytes(bytes))).toEqual(Array.from(pcm));
    expect(fromBytes(Buffer.concat([bytes, Buffer.from([7])])).length).toBe(5);
    const offset = Buffer.concat([Buffer.from([9]), bytes]).subarray(1);
    expect(Array.from(fromBytes(offset))).toEqual(Array.from(pcm));
  });

  it('levels, lengths and generators', () => {
    expect(clamp16(40000)).toBe(32767);
    expect(clamp16(-40000)).toBe(-32768);
    expect(samplesFor(20, 24000)).toBe(480);
    expect(durationMs(480, 24000)).toBe(20);
    expect(silence(20, 8000)).toHaveLength(160);
    expect(rms(new Int16Array(0))).toBe(0);
    expect(dbfs(silence(10, 8000))).toBe(-100);
    const t = tone(100, 24000, { hz: 1000, amplitude: 3277 });
    expect(t).toHaveLength(2400);
    expect(dbfs(t)).toBeGreaterThan(-24);
    expect(dbfs(t)).toBeLessThan(-22);
    expect(t[0]).toBe(0); // fade in
    expect(tone(1, 24000, { fadeMs: 0 })).toHaveLength(24);
    expect(tone(30, 8000)).toHaveLength(240); // defaults
    expect(Array.from(concat(Int16Array.from([1]), Int16Array.from([2, 3])))).toEqual([1, 2, 3]);
  });
});

describe('G.711', () => {
  it('μ-law: every code decodes and re-encodes to itself (except -0)', () => {
    for (let code = 0; code < 256; code += 1) {
      const back = linearToMulaw(mulawToLinear(code));
      expect(back === code || (code === 0x7f && back === 0xff)).toBe(true);
    }
    expect(linearToMulaw(0)).toBe(0xff);
    expect(linearToMulaw(40000)).toBe(linearToMulaw(32767));
    expect(mulawToLinear(0x00)).toBe(-32124);
    expect(mulawToLinear(0x80)).toBe(32124);
  });

  it('A-law: every code decodes and re-encodes to itself', () => {
    for (let code = 0; code < 256; code += 1) {
      expect(linearToAlaw(alawToLinear(code))).toBe(code);
    }
    expect(alawToLinear(0xd5)).toBe(8);
    expect(alawToLinear(0x55)).toBe(-8);
    expect(linearToAlaw(32767)).toBe(0xaa);
    expect(linearToAlaw(-32768)).toBe(0x2a);
  });

  it('clips stay within 2 % of full scale; buffers round-trip', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 20000, -20000]);
    for (const [enc, dec] of [
      [encodeMulaw, decodeMulaw],
      [encodeAlaw, decodeAlaw],
    ] as const) {
      const back = dec(enc(pcm));
      pcm.forEach((s, i) => expect(Math.abs((back[i] ?? 0) - s)).toBeLessThan(700));
    }
  });
});
