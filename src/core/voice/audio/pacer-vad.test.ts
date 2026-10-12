import { describe, expect, it } from 'vitest';

import { FakeClock } from '../clock';

import { Pacer } from './pacer';
import { silence, tone } from './pcm';
import { EnergyVad } from './vad';

const frames = (n: number, value = 1) => Array.from({ length: n }, () => Int16Array.from([value]));

describe('Pacer', () => {
  it('sends one frame per 20 ms in order and resolves completed clips', async () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const pacer = new Pacer({ clock, frameMs: 20, send: (f) => sent.push(f[0] ?? 0) });
    const started: string[] = [];
    const a = pacer.play(frames(3, 1), () => started.push('a'));
    const b = pacer.play(frames(2, 2), () => started.push('b'));
    expect(sent).toEqual([1]); // first frame goes out at once
    expect(pacer.playing).toBe(true);
    clock.advance(20);
    expect(sent).toEqual([1, 1]);
    clock.advance(80);
    expect(sent).toEqual([1, 1, 1, 2, 2]);
    expect(await a).toEqual({ completed: true, playedMs: 60 });
    expect(await b).toEqual({ completed: true, playedMs: 40 });
    expect(started).toEqual(['a', 'b']);
    expect(pacer.playing).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('catches up after a late timer (bounded burst) and counts late ticks', () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const pacer = new Pacer({ clock, frameMs: 20, send: (f) => sent.push(f[0] ?? 0), maxBurst: 3 });
    void pacer.play(frames(10));
    // a 100 ms stall: the next tick may send at most 3 frames
    (clock as unknown as { current: number }).current = 100;
    clock.advance(0);
    clock.advance(20);
    expect(sent.length).toBeGreaterThan(2);
    expect(pacer.lateTicks).toBeGreaterThan(0);
  });

  it('waits while congested (never drops) and clear() stops everything with played ms', async () => {
    const clock = new FakeClock();
    let congested = false;
    const sent: number[] = [];
    const pacer = new Pacer({
      clock,
      frameMs: 20,
      send: (f) => sent.push(f[0] ?? 0),
      congested: () => congested,
    });
    const first = pacer.play(frames(10, 1));
    const second = pacer.play(frames(5, 2));
    congested = true;
    clock.advance(60);
    expect(sent).toHaveLength(1);
    expect(pacer.stalledFrames).toBe(3);
    congested = false;
    clock.advance(40);
    expect(sent).toHaveLength(3);
    expect(pacer.clear()).toBe(60);
    expect(await first).toEqual({ completed: false, playedMs: 60 });
    expect(await second).toEqual({ completed: false, playedMs: 0 });
    expect(pacer.clear()).toBe(0);
    expect(await pacer.play([])).toEqual({ completed: true, playedMs: 0 });
    let started = false;
    await pacer.play([], () => {
      started = true;
    });
    expect(started).toBe(true);
  });
});

describe('EnergyVad', () => {
  it('starts after 3 loud frames and stops after 25 quiet ones', () => {
    const vad = new EnergyVad();
    const loud = tone(20, 24000, { amplitude: 8000, fadeMs: 0 });
    const quiet = silence(20, 24000);
    expect(vad.push(loud)).toBeNull();
    expect(vad.push(loud)).toBeNull();
    expect(vad.push(loud)).toBe('started');
    expect(vad.speaking).toBe(true);
    expect(vad.push(loud)).toBeNull();
    const events = Array.from({ length: 25 }, () => vad.push(quiet));
    expect(events.filter(Boolean)).toEqual(['stopped']);
    expect(events.at(-1)).toBe('stopped');
    vad.push(loud);
    vad.reset();
    expect(vad.speaking).toBe(false);
    const custom = new EnergyVad({ threshold: 10, startFrames: 1, stopFrames: 1 });
    expect(custom.push(Int16Array.from([50, 50]))).toBe('started');
    expect(custom.push(Int16Array.from([0]))).toBe('stopped');
  });
});

describe('Pacer edge cases', () => {
  it('a one-frame clip needs no timer; bursts stop at the end of the queue; default burst is 5', () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const pacer = new Pacer({ clock, frameMs: 20, send: (f) => sent.push(f[0] ?? 0) });
    void pacer.play(frames(1, 9));
    expect(sent).toEqual([9]);
    expect(clock.pending).toBe(0);
    void pacer.play(frames(2, 3));
    (clock as unknown as { current: number }).current += 1000; // very late timer
    clock.advance(0);
    expect(sent).toEqual([9, 3, 3]); // only what was queued
    void pacer.play(frames(12, 4));
    (clock as unknown as { current: number }).current += 1000;
    clock.advance(0);
    expect(sent.filter((v) => v === 4).length).toBe(6); // first frame + one burst of 5
  });
});
