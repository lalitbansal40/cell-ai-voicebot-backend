import { describe, expect, it } from 'vitest';

import { capBounds } from './caps';
import {
  ALL_DAYS,
  canDialAt,
  effectiveWindow,
  fromMinutes,
  intersect,
  isInWindow,
  localClock,
  nextWindowStart,
  toMinutes,
  windowStartFromDay,
} from './window';

const IST = 'Asia/Kolkata';
const LONDON = 'Europe/London';
/** Mon–Sat 09:00–19:00 (the account default). */
const W = { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] };
// 2026-10-19 is a Monday; IST = UTC+05:30
const ist = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`);

describe('window math', () => {
  it('converts HH:mm and reads the local clock', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('19:30')).toBe(1170);
    expect(fromMinutes(545)).toBe('09:05');
    expect(fromMinutes(0)).toBe('00:00');
    expect(localClock(ist('2026-10-19', '09:30'), IST)).toEqual({ day: 1, minutes: 570 });
    expect(localClock(new Date('2026-10-19T04:00:30+05:30'), IST).minutes).toBe(240.5);
  });

  it('start is inclusive, end exclusive; other days and unusable windows are outside', () => {
    expect(isInWindow(ist('2026-10-19', '09:00'), W, IST)).toBe(true);
    expect(isInWindow(ist('2026-10-19', '08:59'), W, IST)).toBe(false);
    expect(isInWindow(ist('2026-10-19', '18:59'), W, IST)).toBe(true);
    expect(isInWindow(ist('2026-10-19', '19:00'), W, IST)).toBe(false);
    expect(isInWindow(ist('2026-10-18', '12:00'), W, IST)).toBe(false); // Sunday
    expect(isInWindow(ist('2026-10-19', '12:00'), { ...W, days: [] }, IST)).toBe(false);
    expect(isInWindow(ist('2026-10-19', '12:00'), { ...W, start: '19:00' }, IST)).toBe(false);
  });

  it('no new dial in the last minutes of a window (end buffer)', () => {
    expect(canDialAt(ist('2026-10-19', '18:55'), W, IST)).toBe(true); // exactly 5 left
    expect(canDialAt(ist('2026-10-19', '18:56'), W, IST)).toBe(false);
    expect(canDialAt(ist('2026-10-19', '18:56'), W, IST, 0)).toBe(true);
    expect(canDialAt(ist('2026-10-19', '20:00'), W, IST)).toBe(false);
  });

  it('next start: now when allowed, later today, tomorrow, after Sunday, after the buffer', () => {
    const now = ist('2026-10-19', '10:00');
    expect(nextWindowStart(now, W, IST)).toBe(now);
    expect(nextWindowStart(ist('2026-10-19', '07:00'), W, IST)).toEqual(ist('2026-10-19', '09:00'));
    expect(nextWindowStart(ist('2026-10-19', '18:57'), W, IST)).toEqual(ist('2026-10-20', '09:00'));
    // Saturday evening → Monday (Sunday is off)
    expect(nextWindowStart(ist('2026-10-24', '19:30'), W, IST)).toEqual(ist('2026-10-26', '09:00'));
    // one day a week
    expect(nextWindowStart(ist('2026-10-19', '19:30'), { ...W, days: [1] }, IST)).toEqual(
      ist('2026-10-26', '09:00'),
    );
    expect(nextWindowStart(now, { ...W, days: [] }, IST)).toBeNull();
    expect(nextWindowStart(now, { ...W, end: '08:00' }, IST)).toBeNull();
  });

  it('window start from a later day (caps, callbacks); no days → that day', () => {
    const now = ist('2026-10-19', '12:00');
    expect(windowStartFromDay(now, 1, W, IST)).toEqual(ist('2026-10-20', '09:00'));
    expect(windowStartFromDay(now, 0, W, IST)).toEqual(ist('2026-10-19', '09:00'));
    expect(windowStartFromDay(ist('2026-10-24', '12:00'), 1, W, IST)).toEqual(
      ist('2026-10-26', '09:00'),
    );
    expect(windowStartFromDay(now, 2, { ...W, days: [] }, IST)).toEqual(ist('2026-10-21', '09:00'));
  });

  it('intersect: later start, earlier end, common days; empty → null', () => {
    expect(intersect(W, { start: '10:00', end: '21:00', days: [0, 1, 6] })).toEqual({
      start: '10:00',
      end: '19:00',
      days: [1, 6],
    });
    expect(intersect(W, { start: '19:00', end: '21:00', days: [1] })).toBeNull();
    expect(intersect(W, { start: '10:00', end: '12:00', days: [0] })).toBeNull();
  });

  it('effective window: account ∩ campaign, + TRAI for live, + RBI for live recovery', () => {
    const wide = { start: '07:00', end: '22:00', days: [...ALL_DAYS] };
    expect(effectiveWindow({ account: wide, campaign: wide, live: false, recovery: true })).toEqual(
      wide,
    );
    expect(effectiveWindow({ account: wide, campaign: wide, live: true, recovery: false })).toEqual(
      {
        start: '09:00',
        end: '21:00',
        days: [...ALL_DAYS],
      },
    );
    expect(effectiveWindow({ account: wide, campaign: wide, live: true, recovery: true })).toEqual({
      start: '09:00',
      end: '19:00',
      days: [...ALL_DAYS],
    });
    expect(
      effectiveWindow({
        account: W,
        campaign: { start: '20:00', end: '21:00', days: [1] },
        live: true,
        recovery: true,
      }),
    ).toBeNull();
    // live early window: TRAI leaves nothing before 09:00
    expect(
      effectiveWindow({
        account: wide,
        campaign: { start: '07:00', end: '08:30', days: [1] },
        live: true,
        recovery: false,
      }),
    ).toBeNull();
  });

  it('DST zone: windows follow local time across the spring and autumn change', () => {
    const LW = { start: '09:00', end: '17:00', days: [...ALL_DAYS] };
    // 2026-03-29: UK clocks go forward (GMT → BST, UTC+1)
    expect(nextWindowStart(new Date('2026-03-28T18:00:00Z'), LW, LONDON)).toEqual(
      new Date('2026-03-29T08:00:00Z'),
    );
    expect(isInWindow(new Date('2026-03-29T08:00:00Z'), LW, LONDON)).toBe(true);
    expect(isInWindow(new Date('2026-03-29T07:59:00Z'), LW, LONDON)).toBe(false);
    // 2026-10-25: back to GMT (UTC+0)
    expect(nextWindowStart(new Date('2026-10-24T18:00:00Z'), LW, LONDON)).toEqual(
      new Date('2026-10-25T09:00:00Z'),
    );
    expect(isInWindow(new Date('2026-10-25T08:30:00Z'), LW, LONDON)).toBe(false);
  });
});

describe('cap bounds', () => {
  it('local day and ISO week (Monday) in the account timezone', () => {
    const b = capBounds(ist('2026-10-21', '01:00'), IST); // Wednesday
    expect(b.dayStart).toEqual(ist('2026-10-21', '00:00'));
    expect(b.nextDayStart).toEqual(ist('2026-10-22', '00:00'));
    expect(b.weekStart).toEqual(ist('2026-10-19', '00:00'));
    expect(b.nextWeekStart).toEqual(ist('2026-10-26', '00:00'));
    // Sunday belongs to the week that started on Monday
    expect(capBounds(ist('2026-10-25', '23:00'), IST).weekStart).toEqual(
      ist('2026-10-19', '00:00'),
    );
  });
});
