import { describe, expect, it } from 'vitest';

import { FakeClock } from './clock';
import { ScaledClock } from './scaled-clock';

describe('ScaledClock', () => {
  it('virtual time moves speed× faster; timers fire after ms / speed of the base clock', () => {
    const base = new FakeClock(1_000);
    const clock = new ScaledClock(20, base);
    expect(clock.now()).toBe(1_000);
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 40_000); // 40 s virtual
    base.advance(1_999);
    expect(fired).toEqual([]);
    base.advance(1);
    expect(fired).toEqual([41_000]); // 2 s real → 40 s virtual
    expect(clock.now()).toBe(41_000);
  });

  it('intervals repeat (never faster than 1 base ms); clearing stops them', () => {
    const base = new FakeClock(0);
    const clock = new ScaledClock(50, base);
    let ticks = 0;
    const every = clock.setInterval(() => (ticks += 1), 20); // 20 / 50 → floored to 1 ms
    base.advance(10);
    expect(ticks).toBe(10);
    clock.clearInterval(every);
    base.advance(10);
    expect(ticks).toBe(10);
    const t = clock.setTimeout(() => (ticks += 100), 1_000);
    clock.clearTimeout(t);
    base.advance(1_000);
    expect(ticks).toBe(10);
  });

  it('speed 1 is the base clock; speeds below 1 are refused', () => {
    const base = new FakeClock(5);
    const clock = new ScaledClock(1, base);
    base.advance(100);
    expect(clock.now()).toBe(105);
    expect(clock.speed).toBe(1);
    expect(() => new ScaledClock(0.5, base)).toThrow(RangeError);
    expect(() => new ScaledClock(Number.NaN, base)).toThrow(RangeError);
    expect(new ScaledClock(2).now()).toBeGreaterThan(0); // system clock default
  });
});
