import { describe, expect, it } from 'vitest';

import type { CallHours } from '../../src/db/models/whatsapp-channel.model';
import { selectRingTargets, withinCallHours } from '../../src/modules/whatsapp-calling/routing';

const hours: CallHours = {
  enabled: true,
  timezone: 'Asia/Kolkata',
  weekly: [{ day: 'SUNDAY', open: '0900', close: '1900' }],
  holidays: [],
};

describe('WhatsApp inbound routing', () => {
  it('uses the configured timezone, weekday and half-open time ranges', () => {
    expect(withinCallHours(hours, new Date('2026-10-25T03:29:00Z'))).toBe(false);
    expect(withinCallHours(hours, new Date('2026-10-25T03:30:00Z'))).toBe(true);
    expect(withinCallHours(hours, new Date('2026-10-25T13:30:00Z'))).toBe(false);
    expect(withinCallHours(hours, new Date('2026-10-26T06:00:00Z'))).toBe(false);
    expect(withinCallHours({ ...hours, enabled: false }, new Date('2026-10-26T06:00:00Z'))).toBe(
      true,
    );
  });

  it('replaces weekly hours with holiday hours, including an entirely closed day', () => {
    const at = new Date('2026-10-25T06:00:00Z');
    expect(
      withinCallHours(
        { ...hours, holidays: [{ date: '2026-10-25', start: '1200', end: '1400' }] },
        at,
      ),
    ).toBe(false);
    expect(
      withinCallHours(
        { ...hours, holidays: [{ date: '2026-10-25', start: '1000', end: '1200' }] },
        at,
      ),
    ).toBe(true);
    expect(
      withinCallHours({ ...hours, holidays: [{ date: '2026-10-25', start: '', end: '' }] }, at),
    ).toBe(false);
  });

  it('rings only online, available users with permission and deduplicates them', () => {
    const input = {
      eligible: ['a', 'b', 'c', 'd', 'a'],
      online: ['a', 'b', 'c'],
      available: ['a', 'c', 'd'],
      ringUserIds: null,
    };
    expect(selectRingTargets(input)).toEqual(['a', 'c']);
    expect(selectRingTargets({ ...input, ringUserIds: ['c', 'd'] })).toEqual(['c']);
    expect(selectRingTargets({ ...input, ringUserIds: [] })).toEqual([]);
    expect(selectRingTargets({ ...input, online: [] })).toEqual([]);
  });
});
