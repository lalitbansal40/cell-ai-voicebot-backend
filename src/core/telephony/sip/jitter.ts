import { seqDiff } from './rtp-packet';

export interface JitterStats {
  received: number;
  lost: number;
  late: number;
  duplicates: number;
  /** RFC 3550 interarrival jitter, in ms. */
  jitterMs: number;
}

/**
 * Puts packets back in order. In-order packets go out at once (no added delay); a missing
 * packet is waited for while at most `maxWaitFrames` later ones are held, then it is
 * concealed by repeating the last frame and counted as lost.
 */
export class JitterBuffer {
  private readonly held = new Map<number, Uint8Array>();
  private next: number | null = null;
  private last: Uint8Array | null = null;
  private transit: number | null = null;
  private jitter = 0;
  private readonly stats = { received: 0, lost: 0, late: 0, duplicates: 0 };

  constructor(
    private readonly maxWaitFrames = 3,
    private readonly clockRate = 8000,
  ) {}

  push(seq: number, timestamp: number, payload: Uint8Array, arrivalMs: number): Uint8Array[] {
    this.updateJitter(timestamp, arrivalMs);
    if (this.next === null) this.next = seq;
    const d = seqDiff(seq, this.next);
    if (d < 0) {
      this.stats.late += 1;
      return [];
    }
    if (this.held.has(seq)) {
      this.stats.duplicates += 1;
      return [];
    }
    this.stats.received += 1;
    this.held.set(seq, payload);
    const out: Uint8Array[] = [];
    for (;;) {
      const ready = this.held.get(this.next);
      if (ready) {
        this.held.delete(this.next);
        out.push(ready);
        this.last = ready;
        this.next = (this.next + 1) & 0xffff;
        continue;
      }
      if (this.held.size <= this.maxWaitFrames) break;
      // give up on the missing packet
      this.stats.lost += 1;
      if (this.last) out.push(this.last);
      this.next = (this.next + 1) & 0xffff;
    }
    return out;
  }

  private updateJitter(timestamp: number, arrivalMs: number): void {
    const transit = arrivalMs - (timestamp * 1000) / this.clockRate;
    if (this.transit !== null) {
      const d = Math.abs(transit - this.transit);
      this.jitter += (d - this.jitter) / 16;
    }
    this.transit = transit;
  }

  get snapshot(): JitterStats {
    return { ...this.stats, jitterMs: Math.round(this.jitter * 10) / 10 };
  }
}
