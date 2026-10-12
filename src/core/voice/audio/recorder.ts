import type { Pcm16 } from './pcm';
import { Resampler } from './resample';

/** Max audio (per side) kept waiting for the next tick — older audio is dropped. */
const MAX_PENDING_MS = 1000;

/**
 * Builds a stereo (customer left, bot right) PCM16 stream at `outRate` from two
 * unsynchronised sources. The call session calls `tick()` every 20 ms: each tick
 * emits exactly 20 ms per side (missing audio = silence), so the recording
 * follows the wall clock of the call.
 */
export class StereoMixer {
  private readonly left: Resampler;
  private readonly right: Resampler;
  private customer: number[] = [];
  private bot: number[] = [];
  private readonly perTick: number;
  private readonly maxPending: number;

  constructor(
    inRate: number,
    readonly outRate: number,
    frameMs = 20,
  ) {
    this.left = new Resampler(inRate, outRate);
    this.right = new Resampler(inRate, outRate);
    this.perTick = (outRate * frameMs) / 1000;
    this.maxPending = (outRate * MAX_PENDING_MS) / 1000;
  }

  addCustomer(frame: Pcm16): void {
    this.customer = this.append(this.customer, this.left.process(frame));
  }

  addBot(frame: Pcm16): void {
    this.bot = this.append(this.bot, this.right.process(frame));
  }

  /** 20 ms of interleaved stereo. */
  tick(): Pcm16 {
    const out = new Int16Array(this.perTick * 2);
    const l = this.customer.splice(0, this.perTick);
    const r = this.bot.splice(0, this.perTick);
    for (let i = 0; i < this.perTick; i += 1) {
      out[i * 2] = l[i] ?? 0;
      out[i * 2 + 1] = r[i] ?? 0;
    }
    return out;
  }

  private append(queue: number[], samples: Pcm16): number[] {
    const next = queue.concat(Array.from(samples));
    return next.length > this.maxPending ? next.slice(next.length - this.maxPending) : next;
  }
}
