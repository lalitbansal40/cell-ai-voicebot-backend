import { describe, expect, it } from 'vitest';

import { addDays, formatDateTimeInZone, startOfDayInZone, ymdInZone } from './time';

describe('time helpers', () => {
  it('finds midnight in a zone', () => {
    expect(startOfDayInZone('2026-10-09', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-08T18:30:00.000Z',
    );
    expect(startOfDayInZone('2026-10-09', 'UTC').toISOString()).toBe('2026-10-09T00:00:00.000Z');
    // DST: New York midnight on 2026-03-08 is still EST (−5)
    expect(startOfDayInZone('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(startOfDayInZone('2026-03-09', 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('formats dates in a zone and adds days', () => {
    const d = new Date('2026-10-08T18:30:00Z');
    expect(ymdInZone(d, 'Asia/Kolkata')).toBe('2026-10-09');
    expect(ymdInZone(d, 'UTC')).toBe('2026-10-08');
    expect(formatDateTimeInZone(d, 'Asia/Kolkata')).toBe('2026-10-09 00:00:00');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});
