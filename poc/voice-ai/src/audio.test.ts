import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  concat,
  decodeMulaw,
  encodeMulaw,
  frames,
  isSilent,
  linearToMulaw,
  mixNoise,
  mulawToLinear,
  readWavPcm16,
  resample,
  rms,
  silence,
  wavFromMulaw,
  wavFromPcm16,
  whiteNoise,
} from './audio.ts';

const sine = (hz: number, ms: number, rate: number, amp = 10_000): Int16Array => {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
};

describe('G.711 μ-law', () => {
  it('matches reference code points', () => {
    assert.equal(linearToMulaw(0), 0xff);
    assert.equal(linearToMulaw(-1), 0x7f);
    assert.equal(mulawToLinear(0xff), 0);
    assert.equal(mulawToLinear(0x80), 32124);
    assert.equal(mulawToLinear(0x00), -32124);
  });

  it('round-trips with bounded quantisation error', () => {
    for (let s = -32000; s <= 32000; s += 97) {
      const back = mulawToLinear(linearToMulaw(s));
      const tolerance = Math.max(8, Math.abs(s) * 0.07); // logarithmic steps
      assert.ok(Math.abs(back - s) <= tolerance, `sample ${s} → ${back}`);
    }
  });

  it('encodes/decodes buffers of the same length', () => {
    const pcm = sine(440, 100, 8000);
    const encoded = encodeMulaw(pcm);
    assert.equal(encoded.length, pcm.length);
    assert.equal(decodeMulaw(encoded).length, pcm.length);
  });
});

describe('resample', () => {
  it('produces the expected length (24k → 8k → 24k)', () => {
    const pcm = sine(300, 1000, 24_000);
    const down = resample(pcm, 24_000, 8000);
    assert.equal(down.length, 8000);
    assert.equal(resample(down, 8000, 24_000).length, 24_000);
  });

  it('keeps a low-frequency tone roughly the same loudness', () => {
    const pcm = sine(300, 500, 24_000);
    const down = resample(pcm, 24_000, 8000);
    const ratio = rms(down) / rms(pcm);
    assert.ok(ratio > 0.8 && ratio < 1.1, `rms ratio ${ratio}`);
  });

  it('returns a copy for equal rates', () => {
    const pcm = sine(300, 20, 24_000);
    const out = resample(pcm, 24_000, 24_000);
    assert.notEqual(out, pcm);
    assert.deepEqual(out, pcm);
  });
});

describe('frames', () => {
  it('makes 20 ms frames of 480 samples (960 bytes) at 24 kHz', () => {
    const f = frames(silence(100, 24_000), 24_000);
    assert.equal(f.length, 5);
    assert.equal(f[0]?.length, 480);
    assert.equal((f[0]?.length ?? 0) * 2, 960);
  });

  it('makes 160-sample frames at 8 kHz and pads the last one', () => {
    const f = frames(new Int16Array(170), 8000);
    assert.equal(f.length, 2);
    assert.equal(f[1]?.length, 160);
  });
});

describe('noise & silence', () => {
  it('detects silence and non-silence', () => {
    assert.ok(isSilent(silence(20, 8000)));
    assert.ok(!isSilent(sine(300, 20, 8000)));
  });

  it('mixes noise at roughly the requested SNR', () => {
    const signal = sine(300, 1000, 8000);
    const mixed = mixNoise(signal, 8000, 10);
    const noise = new Int16Array(signal.length);
    for (let i = 0; i < signal.length; i += 1) noise[i] = (mixed[i] ?? 0) - (signal[i] ?? 0);
    const snr = 20 * Math.log10(rms(signal) / rms(noise));
    assert.ok(Math.abs(snr - 10) < 1, `snr ${snr}`);
  });

  it('is deterministic for the same seed', () => {
    assert.deepEqual(whiteNoise(20, 8000, 500, 7), whiteNoise(20, 8000, 500, 7));
  });

  it('concatenates buffers', () => {
    assert.equal(concat(silence(10, 8000), silence(20, 8000)).length, 240);
  });
});

describe('WAV', () => {
  it('writes and reads PCM16', () => {
    const pcm = sine(440, 50, 24_000);
    const wav = wavFromPcm16(pcm, 24_000);
    assert.equal(wav.length, 44 + pcm.length * 2);
    const back = readWavPcm16(wav);
    assert.equal(back.rate, 24_000);
    assert.deepEqual(back.pcm, pcm);
  });

  it('writes μ-law WAV and reads it back as PCM16', () => {
    const pcm = sine(440, 50, 8000);
    const wav = wavFromMulaw(encodeMulaw(pcm));
    assert.equal(wav.readUInt16LE(20), 7); // format = μ-law
    const back = readWavPcm16(wav);
    assert.equal(back.rate, 8000);
    assert.equal(back.pcm.length, pcm.length);
  });
});
