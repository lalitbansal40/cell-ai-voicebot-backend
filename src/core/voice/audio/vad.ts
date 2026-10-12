import { rms, type Pcm16 } from './pcm';

export type VadEvent = 'started' | 'stopped' | null;

export interface VadOptions {
  /** RMS level (PCM16 units) counted as voice — 1000 ≈ -30 dBFS. */
  threshold?: number;
  /** Voiced frames in a row to start. */
  startFrames?: number;
  /** Quiet frames in a row to stop (25 × 20 ms = 500 ms). */
  stopFrames?: number;
}

/** Energy voice-activity detector with start / hangover counters (one 20 ms frame at a time). */
export class EnergyVad {
  private readonly threshold: number;
  private readonly startFrames: number;
  private readonly stopFrames: number;
  private voiced = 0;
  private quiet = 0;
  private active = false;

  constructor(options: VadOptions = {}) {
    this.threshold = options.threshold ?? 1000;
    this.startFrames = options.startFrames ?? 3;
    this.stopFrames = options.stopFrames ?? 25;
  }

  get speaking(): boolean {
    return this.active;
  }

  push(frame: Pcm16): VadEvent {
    const loud = rms(frame) >= this.threshold;
    if (loud) {
      this.voiced += 1;
      this.quiet = 0;
    } else {
      this.quiet += 1;
      this.voiced = 0;
    }
    if (!this.active && this.voiced >= this.startFrames) {
      this.active = true;
      return 'started';
    }
    if (this.active && this.quiet >= this.stopFrames) {
      this.active = false;
      return 'stopped';
    }
    return null;
  }

  reset(): void {
    this.voiced = 0;
    this.quiet = 0;
    this.active = false;
  }
}
