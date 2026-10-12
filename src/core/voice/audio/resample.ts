import { clamp16, type Pcm16 } from './pcm';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/** Blackman window over (-half, half). */
const blackman = (d: number, half: number): number =>
  Math.abs(d) >= half
    ? 0
    : 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((2 * Math.PI * d) / half);

/**
 * Streaming windowed-sinc resampler for rational rate pairs (8 / 16 / 24 kHz …).
 * Output sample `n` is computed at input time `n × from / to` exactly (zero
 * phase, `half` input samples of lookahead), so 20 ms chunks join seamlessly
 * and audio stays aligned with its timestamps. Kernels are precomputed per phase.
 */
export class Resampler {
  readonly from: number;
  readonly to: number;
  private readonly up: number;
  private readonly down: number;
  private readonly half: number;
  private readonly kernels: Float32Array[];
  /** Input samples not yet released; `buf[0]` is absolute input index `bufStart`. */
  private buf: Float32Array = new Float32Array(0);
  private bufStart = 0;
  private received = 0;
  private produced = 0;

  constructor(from: number, to: number) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
      throw new RangeError('Sample rates must be positive integers');
    }
    this.from = from;
    this.to = to;
    const g = gcd(from, to);
    this.up = to / g;
    this.down = from / g;
    const cutoff = Math.min(1, to / from) * 0.92;
    this.half = Math.ceil(8 / cutoff);
    this.kernels = [];
    for (let phase = 0; phase < this.up; phase += 1) {
      const weights = new Float32Array(2 * this.half);
      let sum = 0;
      for (let j = 0; j < weights.length; j += 1) {
        const d = phase / this.up + this.half - 1 - j;
        const w = cutoff * sinc(cutoff * d) * blackman(d, this.half);
        weights[j] = w;
        sum += w;
      }
      for (const [j, w] of weights.entries()) weights[j] = w / sum;
      this.kernels.push(weights);
    }
  }

  /** Lookahead in input samples (latency of the streaming output). */
  get lookahead(): number {
    return this.half;
  }

  process(input: Pcm16): Pcm16 {
    if (this.from === this.to) return input.slice();
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    this.buf = merged;
    this.received += input.length;
    return this.drain(this.received);
  }

  /** Ends the stream: pads `lookahead` zeros so every sample up to the end is produced. */
  flush(): Pcm16 {
    if (this.from === this.to) return new Int16Array(0);
    const total = this.received;
    const padded = new Float32Array(this.buf.length + this.half);
    padded.set(this.buf);
    this.buf = padded;
    this.received += this.half;
    const out = this.drain(this.received, total);
    return out;
  }

  /** Resamples a whole clip (process + flush). */
  static convert(input: Pcm16, from: number, to: number): Pcm16 {
    if (from === to) return input.slice();
    const r = new Resampler(from, to);
    const a = r.process(input);
    const b = r.flush();
    const out = new Int16Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  private drain(available: number, limitInput = Infinity): Pcm16 {
    const values: number[] = [];
    for (;;) {
      const pos = this.produced * this.down;
      const base = Math.floor(pos / this.up);
      if (base >= limitInput) break;
      if (base + this.half >= available) break;
      const phase = pos - base * this.up;
      const kernel = this.kernels[phase] as Float32Array;
      const first = base - this.half + 1;
      let acc = 0;
      for (const [j, weight] of kernel.entries()) {
        const index = first + j - this.bufStart;
        if (index >= 0) acc += weight * (this.buf[index] as number);
      }
      values.push(clamp16(acc));
      this.produced += 1;
    }
    // keep only what the next outputs can still reach
    const nextBase = Math.floor((this.produced * this.down) / this.up);
    const keepFrom = Math.max(this.bufStart, nextBase - this.half + 1);
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(keepFrom - this.bufStart);
      this.bufStart = keepFrom;
    }
    return Int16Array.from(values);
  }
}
