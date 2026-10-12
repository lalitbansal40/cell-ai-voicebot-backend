/** PCM16 mono helpers (little-endian on the wire). */
export type Pcm16 = Int16Array;

export const clamp16 = (value: number): number =>
  Math.max(-32768, Math.min(32767, Math.round(value)));

/** Bytes (LE) → samples; a trailing odd byte is ignored. */
export const fromBytes = (bytes: Uint8Array): Pcm16 => {
  const out = new Int16Array(bytes.length >> 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
};

export const toBytes = (pcm: Pcm16): Buffer => {
  const out = Buffer.alloc(pcm.length * 2);
  pcm.forEach((value, i) => out.writeInt16LE(value, i * 2));
  return out;
};

export const samplesFor = (ms: number, rate: number): number => Math.round((ms * rate) / 1000);

export const durationMs = (samples: number, rate: number): number =>
  Math.round((samples * 1000) / rate);

export const silence = (ms: number, rate: number): Pcm16 => new Int16Array(samplesFor(ms, rate));

export const rms = (pcm: Pcm16): number => {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
};

/** Level in dBFS (full scale 32768); silence → -100. */
export const dbfs = (pcm: Pcm16): number => {
  const level = rms(pcm);
  return level === 0 ? -100 : 20 * Math.log10(level / 32768);
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

/** Sine tone with linear fade in / out (deterministic test / fake-TTS audio). */
export const tone = (
  ms: number,
  rate: number,
  options: { hz?: number; amplitude?: number; fadeMs?: number } = {},
): Pcm16 => {
  const hz = options.hz ?? 440;
  const amplitude = options.amplitude ?? 3277;
  const n = samplesFor(ms, rate);
  const fade = Math.min(samplesFor(options.fadeMs ?? 10, rate), n >> 1);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const edge = Math.min(i, n - 1 - i);
    const gain = fade > 0 && edge < fade ? edge / fade : 1;
    out[i] = clamp16(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * gain);
  }
  return out;
};
