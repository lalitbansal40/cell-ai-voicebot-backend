/**
 * Audio helpers for the PoC: PCM16 <-> Float32, resampling, G.711 μ-law,
 * noise/silence generation, WAV read/write and 20 ms framing.
 * All PCM16 buffers are little-endian mono.
 */

export type Pcm16 = Int16Array;

export const SAMPLE_RATE_REALTIME = 24_000;
export const SAMPLE_RATE_PHONE = 8_000;
export const FRAME_MS = 20;

export const pcm16ToFloat32 = (pcm: Pcm16): Float32Array => {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
};

export const float32ToPcm16 = (samples: Float32Array): Pcm16 => {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
};

export const bufferToPcm16 = (buf: Buffer): Pcm16 => {
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
};

export const pcm16ToBuffer = (pcm: Pcm16): Buffer => {
  const buf = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) buf.writeInt16LE(pcm[i] ?? 0, i * 2);
  return buf;
};

/**
 * Resample with linear interpolation. When downsampling, a moving-average
 * pre-filter (width = ratio) reduces aliasing — good enough for a PoC that
 * simulates phone-band audio; the production audio bridge should use a proper
 * polyphase/sinc resampler.
 */
export const resample = (input: Pcm16, fromRate: number, toRate: number): Pcm16 => {
  if (fromRate === toRate) return input.slice();
  let source: Float32Array = pcm16ToFloat32(input);
  if (toRate < fromRate) {
    const width = Math.max(1, Math.round(fromRate / toRate));
    const filtered = new Float32Array(source.length);
    let acc = 0;
    for (let i = 0; i < source.length; i += 1) {
      acc += source[i] ?? 0;
      if (i >= width) acc -= source[i - width] ?? 0;
      filtered[i] = acc / Math.min(i + 1, width);
    }
    source = filtered;
  }
  const outLength = Math.round((source.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * step;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = source[idx] ?? 0;
    const b = source[Math.min(idx + 1, source.length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return float32ToPcm16(out);
};

// ── G.711 μ-law (ITU-T G.711) ───────────────────────────────────────────────
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const mulawExponent = (value: number): number => {
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  return exponent;
};

export const linearToMulaw = (sample: number): number => {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  const exponent = mulawExponent(s);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

export const mulawToLinear = (byte: number): number => {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -magnitude : magnitude;
};

export const encodeMulaw = (pcm: Pcm16): Buffer => {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = linearToMulaw(pcm[i] ?? 0);
  return out;
};

export const decodeMulaw = (bytes: Uint8Array): Pcm16 => {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = mulawToLinear(bytes[i] ?? 0xff);
  return out;
};

// ── Generators ─────────────────────────────────────────────────────────────
export const silence = (ms: number, rate: number): Pcm16 =>
  new Int16Array(Math.round((ms / 1000) * rate));

export const rms = (pcm: Pcm16): number => {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
};

/** Deterministic PRNG so noise-mixed test audio is reproducible across runs. */
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** White noise at `rmsLevel` (PCM16 units). */
export const whiteNoise = (ms: number, rate: number, rmsLevel: number, seed = 42): Pcm16 => {
  const random = mulberry32(seed);
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  const amplitude = rmsLevel * Math.sqrt(3); // uniform distribution RMS = A/√3
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round((random() * 2 - 1) * amplitude)));
  }
  return out;
};

/** Mix white noise into `signal` so the result has the given SNR (dB). */
export const mixNoise = (signal: Pcm16, rate: number, snrDb: number, seed = 42): Pcm16 => {
  const signalRms = rms(signal) || 1;
  const noiseRms = signalRms / 10 ** (snrDb / 20);
  const noise = whiteNoise((signal.length / rate) * 1000, rate, noiseRms, seed);
  const out = new Int16Array(signal.length);
  for (let i = 0; i < signal.length; i += 1) {
    out[i] = Math.max(-32768, Math.min(32767, (signal[i] ?? 0) + (noise[i] ?? 0)));
  }
  return out;
};

export const concat = (...parts: Pcm16[]): Pcm16 => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

/** Splits into 20 ms frames (last frame zero-padded). */
export const frames = (pcm: Pcm16, rate: number, frameMs = FRAME_MS): Pcm16[] => {
  const size = Math.round((frameMs / 1000) * rate);
  const out: Pcm16[] = [];
  for (let i = 0; i < pcm.length; i += size) {
    const frame = new Int16Array(size);
    frame.set(pcm.subarray(i, Math.min(i + size, pcm.length)));
    out.push(frame);
  }
  return out;
};

/** True when a frame is (near) silent — used to find the end of customer speech. */
export const isSilent = (frame: Pcm16, threshold = 300): boolean => rms(frame) < threshold;

// ── WAV ────────────────────────────────────────────────────────────────────
const wavHeader = (dataBytes: number, rate: number, format: 1 | 7, bitsPerSample: 8 | 16) => {
  const blockAlign = bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
};

export const wavFromPcm16 = (pcm: Pcm16, rate: number): Buffer => {
  const data = pcm16ToBuffer(pcm);
  return Buffer.concat([wavHeader(data.length, rate, 1, 16), data]);
};

export const wavFromMulaw = (bytes: Uint8Array, rate = SAMPLE_RATE_PHONE): Buffer =>
  Buffer.concat([wavHeader(bytes.length, rate, 7, 8), Buffer.from(bytes)]);

export const readWavPcm16 = (wav: Buffer): { rate: number; pcm: Pcm16 } => {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let rate = 0;
  let format = 0;
  let bits = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      format = wav.readUInt16LE(offset + 8);
      rate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      const data = wav.subarray(offset + 8, offset + 8 + size);
      if (format === 1 && bits === 16) return { rate, pcm: bufferToPcm16(data) };
      if (format === 7 && bits === 8) return { rate, pcm: decodeMulaw(data) };
      throw new Error(`Unsupported WAV format ${format}/${bits}`);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV data chunk not found');
};

export const durationMs = (samples: number, rate: number): number => (samples / rate) * 1000;
