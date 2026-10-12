/** Time source for calls — real in production, `FakeClock` in tests and benches. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

interface Timer {
  id: number;
  at: number;
  every: number | null;
  fn: () => void;
}

/** Deterministic clock: time moves only through `advance` / `tick`. */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): number {
    return this.add(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): number {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  /** Pending timers (tests). */
  get pending(): number {
    return this.timers.length;
  }

  /** Moves time forward by `ms`, firing due timers in order (intervals repeat). */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.current = Math.max(this.current, due.at);
      if (due.every === null) this.clearTimeout(due.id);
      // like real timers: a late interval does not replay the ticks it missed
      else due.at = Math.max(due.at, this.current) + due.every;
      due.fn();
    }
    this.current = target;
  }

  /** `advance` that also lets queued promises settle between steps. */
  async tick(ms: number, step = 20): Promise<void> {
    for (let left = ms; left > 0; left -= step) {
      this.advance(Math.min(step, left));
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.current + Math.max(0, ms), every, fn });
    return id;
  }
}
