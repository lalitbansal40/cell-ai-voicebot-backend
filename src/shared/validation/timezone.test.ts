import { describe, expect, it } from 'vitest';

import { isTimezone } from './timezone';

describe('isTimezone', () => {
  it.each([
    'Asia/Kolkata',
    'Asia/Calcutta',
    'Asia/Dubai',
    'America/Argentina/Buenos_Aires',
    'UTC',
    'Etc/GMT+5',
  ])('accepts %s', (zone) => expect(isTimezone(zone)).toBe(true));

  it.each(['Mars/Olympus', 'Nowhere/Land', '+05:30', '-0800', 'IST', '', 'Asia/', 'asia kolkata'])(
    'rejects %j',
    (zone) => expect(isTimezone(zone)).toBe(false),
  );
});
