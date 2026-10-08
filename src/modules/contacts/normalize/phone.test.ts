import { describe, expect, it } from 'vitest';

import { normalizePhone, phoneDigits } from './phone';

describe('normalizePhone (default IN)', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['(+91) 98765.43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['0091 9876543210', '+919876543210'],
    ['+91 (0) 98765 43210', '+919876543210'],
    ["'9876543210", '+919876543210'],
    ['  98765 43210  ', '+919876543210'],
    ['9876543210.0', '+919876543210'],
    ['98765/43210', '+919876543210'],
    ['+911123456789', '+911123456789'], // Delhi landline
    ['011 2345 6789', '+911123456789'],
    ['+1 415 555 2671', '+14155552671'], // US number, explicit country
    ['+44 20 7946 0958', '+442079460958'],
    [9876543210, '+919876543210'],
    [919876543210, '+919876543210'],
  ])('%j → %s', (raw, e164) => {
    expect(normalizePhone(raw)).toEqual({ ok: true, e164 });
  });

  it.each([
    [null, 'phone_missing'],
    [undefined, 'phone_missing'],
    ['', 'phone_missing'],
    ['   ', 'phone_missing'],
    ["'", 'phone_missing'],
    ['9.87654E+09', 'phone_lost_digits'],
    ['9.876543210e9', 'phone_lost_digits'],
    ['9,87654E+09', 'phone_lost_digits'],
    [9.87654e9 + 0.5, 'phone_lost_digits'],
    ['98765 43210 ext 5', 'phone_invalid'],
    ['call me', 'phone_invalid'],
    ['12345', 'phone_invalid'],
    ['+91 12345', 'phone_invalid'],
    ['98765#43210', 'phone_invalid'],
    ['0000000000', 'phone_invalid'],
    [-9876543210, 'phone_invalid'],
    [Number.NaN, 'phone_invalid'],
    [{}, 'phone_invalid'],
    [true, 'phone_invalid'],
  ])('%j → %s', (raw, reason) => {
    expect(normalizePhone(raw)).toEqual({ ok: false, reason });
  });

  it('uses the account country for national numbers', () => {
    expect(normalizePhone('020 7946 0958', 'GB')).toEqual({ ok: true, e164: '+442079460958' });
    expect(normalizePhone('4155552671', 'US')).toEqual({ ok: true, e164: '+14155552671' });
  });

  it('extracts digits for search', () => {
    expect(phoneDigits('+91 98765-43210')).toBe('919876543210');
  });
});
