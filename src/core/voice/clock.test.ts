import { describe, expect, it, vi } from 'vitest';

import { FakeClock, systemClock } from './clock';

describe('clocks', () => {
  it('fake clock fires timeouts once and intervals repeatedly, in order', () => {
    const clock = new FakeClock(1000);
    const calls: string[] = [];
    const t = clock.setTimeout(() => calls.push(`t@${String(clock.now())}`), 50);
    clock.setInterval(() => calls.push(`i@${String(clock.now())}`), 20);
    const gone = clock.setTimeout(() => calls.push('never'), 10);
    clock.clearTimeout(gone);
    expect(clock.pending).toBe(2);
    clock.advance(60);
    expect(calls).toEqual(['i@1020', 'i@1040', 't@1050', 'i@1060']);
    expect(clock.now()).toBe(1060);
    clock.clearTimeout(t);
    expect(clock.pending).toBe(1);
    clock.clearInterval(2);
    expect(clock.pending).toBe(0);
    // a zero / negative delay fires on the next advance
    clock.setTimeout(() => calls.push('now'), -5);
    clock.setInterval(() => calls.push('fast'), 0);
    clock.advance(1);
    expect(calls.slice(-3)).toEqual(['now', 'fast', 'fast']);
  });

  it('tick advances in steps and lets promises settle', async () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    clock.setTimeout(() => {
      void Promise.resolve().then(() => seen.push(clock.now()));
    }, 30);
    await clock.tick(50);
    expect(seen).toEqual([40]);
    expect(clock.now()).toBe(50);
    await clock.tick(5, 20);
    expect(clock.now()).toBe(55);
  });

  it('system clock wraps the global timers', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = systemClock.setTimeout(fn, 10);
    const i = systemClock.setInterval(fn, 10);
    vi.advanceTimersByTime(25);
    expect(fn).toHaveBeenCalledTimes(3);
    systemClock.clearTimeout(t);
    systemClock.clearInterval(i);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(systemClock.now()).toBe(Date.now());
    vi.useRealTimers();
  });
});
