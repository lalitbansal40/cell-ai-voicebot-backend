import type { Clock } from '../clock';

import type { Pcm16 } from './pcm';

export interface PlaybackResult {
  /** False when `clear()` stopped it (barge-in / hangup). */
  completed: boolean;
  playedMs: number;
}

interface Item {
  frames: Pcm16[];
  next: number;
  resolve: (result: PlaybackResult) => void;
  onStart?: (() => void) | undefined;
}

export interface PacerOptions {
  clock: Clock;
  frameMs: number;
  send: (frame: Pcm16) => void;
  /** True while the transport is backed up — frames wait (never dropped, never queued unbounded). */
  congested?: () => boolean;
  /** Frames sent per tick at most when catching up after a late timer. */
  maxBurst?: number;
}

/**
 * Sends queued audio in real time (one frame per `frameMs`, catching up after
 * late timers). `play` resolves when the clip finished or was cleared.
 */
export class Pacer {
  private readonly queue: Item[] = [];
  private timer: unknown = null;
  private startedAt = 0;
  private sent = 0;
  private late = 0;
  private stalled = 0;

  constructor(private readonly options: PacerOptions) {}

  get playing(): boolean {
    return this.queue.length > 0;
  }

  /** Frames that had to wait for a congested transport. */
  get stalledFrames(): number {
    return this.stalled;
  }

  /** Ticks where more than one frame had to be sent (timer lateness). */
  get lateTicks(): number {
    return this.late;
  }

  play(frames: Pcm16[], onStart?: () => void): Promise<PlaybackResult> {
    return new Promise((resolve) => {
      if (frames.length === 0) {
        onStart?.();
        resolve({ completed: true, playedMs: 0 });
        return;
      }
      this.queue.push({ frames, next: 0, resolve, onStart });
      this.ensureRunning();
    });
  }

  /** Drops everything queued; the current clip resolves `completed: false` with its played ms. */
  clear(): number {
    const current = this.queue[0];
    const playedMs = current ? current.next * this.options.frameMs : 0;
    for (const item of this.queue.splice(0)) {
      item.resolve({ completed: false, playedMs: item === current ? playedMs : 0 });
    }
    this.stop();
    return playedMs;
  }

  stop(): void {
    if (this.timer !== null) this.options.clock.clearInterval(this.timer);
    this.timer = null;
  }

  private ensureRunning(): void {
    if (this.timer !== null) return;
    this.startedAt = this.options.clock.now();
    this.sent = 0;
    this.tick();
    if (this.queue.length > 0) {
      this.timer = this.options.clock.setInterval(() => this.tick(), this.options.frameMs);
    }
  }

  private tick(): void {
    const due =
      Math.floor((this.options.clock.now() - this.startedAt) / this.options.frameMs) +
      1 -
      this.sent;
    const burst = Math.min(Math.max(due, 0), this.options.maxBurst ?? 5);
    if (burst > 1) this.late += 1;
    for (let i = 0; i < burst; i += 1) {
      const item = this.queue[0];
      if (!item) break;
      if (this.options.congested?.()) {
        this.stalled += 1;
        // resync: the frames we could not send now are not "late" later
        this.startedAt += this.options.frameMs;
        break;
      }
      if (item.next === 0) item.onStart?.();
      const frame = item.frames[item.next] as Pcm16;
      item.next += 1;
      this.sent += 1;
      this.options.send(frame);
      if (item.next >= item.frames.length) {
        this.queue.shift();
        item.resolve({ completed: true, playedMs: item.frames.length * this.options.frameMs });
      }
    }
    if (this.queue.length === 0) this.stop();
  }
}
