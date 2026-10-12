import type { Pcm16 } from './pcm';

/** Cuts any chunk sizes into exact frames; the remainder waits for more audio. */
export class Framer {
  private pending: Pcm16 = new Int16Array(0);

  constructor(readonly frameSamples: number) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new RangeError('frameSamples must be a positive integer');
    }
  }

  get buffered(): number {
    return this.pending.length;
  }

  push(chunk: Pcm16): Pcm16[] {
    const all = new Int16Array(this.pending.length + chunk.length);
    all.set(this.pending);
    all.set(chunk, this.pending.length);
    const frames: Pcm16[] = [];
    let offset = 0;
    for (; offset + this.frameSamples <= all.length; offset += this.frameSamples) {
      frames.push(all.slice(offset, offset + this.frameSamples));
    }
    this.pending = all.slice(offset);
    return frames;
  }

  /** The last partial frame padded with silence, or `null` when nothing is left. */
  flush(): Pcm16 | null {
    if (this.pending.length === 0) return null;
    const frame = new Int16Array(this.frameSamples);
    frame.set(this.pending);
    this.pending = new Int16Array(0);
    return frame;
  }

  /** Whole clip → frames (last one padded). */
  static split(pcm: Pcm16, frameSamples: number): Pcm16[] {
    const f = new Framer(frameSamples);
    const frames = f.push(pcm);
    const last = f.flush();
    if (last) frames.push(last);
    return frames;
  }
}
