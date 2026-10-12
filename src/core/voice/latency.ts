import { CALL_LIMITS } from '../../config/limits';
import type { CallLatency } from '../../db/models/call.model';

/** Customer stops speaking → first bot audio frame (ms), per turn. */
export class LatencyMeter {
  private pendingSince: number | null = null;
  private readonly samples: number[] = [];

  /** Customer finished (VAD stop / key press / typed text). */
  customerDone(now: number): void {
    this.pendingSince = now;
  }

  /** A bot frame went out; returns the sample when this was the first after the customer. */
  botAudio(now: number): number | null {
    if (this.pendingSince === null) return null;
    const ms = Math.max(0, now - this.pendingSince);
    this.pendingSince = null;
    if (this.samples.length < CALL_LIMITS.latencySamplesMax) this.samples.push(ms);
    return ms;
  }

  summary(): CallLatency {
    if (this.samples.length === 0) return { p50Ms: null, p95Ms: null, maxMs: null, samples: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
    return {
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      maxMs: sorted.at(-1) as number,
      samples: sorted.length,
    };
  }
}
