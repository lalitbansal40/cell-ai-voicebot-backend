import { systemClock, type Clock } from './clock';

/**
 * Virtual time for dry-run calls (PHASE_8_PROMPT §1 "Dry-run provider"):
 * timers fire after `ms / speed` real ms and `now()` moves `speed×`, so a
 * 40 s call takes 2 s at ×20 but its timestamps / duration say 40 s.
 * Built on any base clock (`FakeClock` in tests). Speed 1 = the base clock.
 */
export class ScaledClock implements Clock {
  private readonly realStart: number;

  constructor(
    readonly speed: number,
    private readonly base: Clock = systemClock,
  ) {
    if (!Number.isFinite(speed) || speed < 1) throw new RangeError('speed must be ≥ 1');
    this.realStart = base.now();
  }

  now(): number {
    return this.realStart + (this.base.now() - this.realStart) * this.speed;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return this.base.setTimeout(fn, ms / this.speed);
  }

  clearTimeout(handle: unknown): void {
    this.base.clearTimeout(handle);
  }

  setInterval(fn: () => void, ms: number): unknown {
    return this.base.setInterval(fn, Math.max(1, ms / this.speed));
  }

  clearInterval(handle: unknown): void {
    this.base.clearInterval(handle);
  }
}
