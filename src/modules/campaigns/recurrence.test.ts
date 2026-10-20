import { describe, expect, it } from 'vitest';

import { cronOf, nextOccurrence, nextOccurrences, runLabel } from './recurrence';

const IST = 'Asia/Kolkata';
const ist = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`);
// Monday 19 Oct 2026, 10:00 IST
const MON = ist('2026-10-19', '10:00');

describe('nextOccurrences', () => {
  it('daily: today when the time is still ahead, then every day', () => {
    expect(
      nextOccurrences({ freq: 'daily', days: [], time: '11:30', until: null }, IST, MON, 3),
    ).toEqual([ist('2026-10-19', '11:30'), ist('2026-10-20', '11:30'), ist('2026-10-21', '11:30')]);
    // exactly now is not "after now"
    expect(
      nextOccurrences({ freq: 'daily', days: [], time: '10:00', until: null }, IST, MON, 1),
    ).toEqual([ist('2026-10-20', '10:00')]);
  });

  it('weekly: only the chosen days (Sunday = 0)', () => {
    expect(
      nextOccurrences({ freq: 'weekly', days: [0, 3], time: '09:00', until: null }, IST, MON, 3),
    ).toEqual([ist('2026-10-21', '09:00'), ist('2026-10-25', '09:00'), ist('2026-10-28', '09:00')]);
    expect(
      nextOccurrences({ freq: 'weekly', days: [], time: '09:00', until: null }, IST, MON, 2),
    ).toEqual([]);
  });

  it('until: nothing after it (inclusive)', () => {
    const until = ist('2026-10-21', '11:30');
    expect(nextOccurrences({ freq: 'daily', days: [], time: '11:30', until }, IST, MON, 5)).toEqual(
      [ist('2026-10-19', '11:30'), ist('2026-10-20', '11:30'), until],
    );
    expect(
      nextOccurrence({ freq: 'daily', days: [], time: '11:30', until: MON }, IST, MON),
    ).toBeNull();
  });

  it('DST (Europe/London): wall time kept across the change; a skipped hour moves forward', () => {
    // clocks go back on Sun 25 Oct 2026 02:00 BST → 01:00 GMT
    const from = new Date('2026-10-24T12:00:00Z');
    expect(
      nextOccurrences(
        { freq: 'daily', days: [], time: '09:00', until: null },
        'Europe/London',
        from,
        2,
      ),
    ).toEqual([new Date('2026-10-25T09:00:00Z'), new Date('2026-10-26T09:00:00Z')]);
    expect(
      nextOccurrences(
        { freq: 'daily', days: [], time: '09:00', until: null },
        'Europe/London',
        new Date('2026-10-23T12:00:00Z'),
        1,
      ),
    ).toEqual([new Date('2026-10-24T08:00:00Z')]); // still BST
    // clocks go forward on Sun 28 Mar 2027 01:00 GMT → 02:00 BST: 01:30 does not exist
    expect(
      nextOccurrences(
        { freq: 'weekly', days: [0], time: '01:30', until: null },
        'Europe/London',
        new Date('2027-03-27T12:00:00Z'),
        1,
      )[0]?.toISOString(),
    ).toBe('2027-03-28T01:30:00.000Z'); // 02:30 BST
  });
});

describe('cronOf / runLabel', () => {
  it('builds the scheduler pattern', () => {
    expect(cronOf({ freq: 'daily', days: [], time: '09:05' })).toBe('5 9 * * *');
    expect(cronOf({ freq: 'weekly', days: [5, 1, 3], time: '18:30' })).toBe('30 18 * * 1,3,5');
  });

  it('labels a run by its local day', () => {
    expect(runLabel(new Date('2026-10-15T20:00:00Z'), IST)).toBe('16 Oct');
    expect(runLabel(new Date('2026-10-15T20:00:00Z'), 'Europe/London')).toBe('15 Oct');
  });
});
