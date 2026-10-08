import { describe, expect, it } from 'vitest';

import {
  cleanDecimal,
  excelSerialToIso,
  formatFieldValue,
  fromMicros,
  parseDate,
  parseFieldValue,
  toIsoDate,
  toMicros,
} from './values';

describe('cleanDecimal', () => {
  it.each([
    ['1,25,000', '125000'],
    ['1,250,000', '1250000'],
    ['12,50,000.75', '1250000.75'],
    ['₹ 12,500', '12500'],
    ['₹12500.5', '12500.5'],
    ['Rs. 500', '500'],
    ['Rs 500/-', '500'],
    ['500/-', '500'],
    ['INR 99', '99'],
    ['99 INR', '99'],
    ['-12.5', '-12.5'],
    ['+7', '7'],
    ['₹ -500', '-500'],
    ['- 500', '-500'],
    ['.5', '0.5'],
    ['0', '0'],
    ['1 000', '1000'],
    [42, '42'],
    [-0.25, '-0.25'],
  ])('%j → %s', (raw, expected) => {
    expect(cleanDecimal(raw)).toBe(expected);
  });

  it.each([
    ['12,34'],
    ['1,2345'],
    ['abc'],
    ['12a'],
    ['1.2.3'],
    [''],
    ['-'],
    ['₹'],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [1e21],
    [1e-7],
    ['9999999999999999'],
    [true],
  ])('%j → undefined', (raw) => {
    expect(cleanDecimal(raw)).toBeUndefined();
  });
});

describe('micros', () => {
  it.each([
    ['12500.10', 12_500_100_000],
    ['12500.1', 12_500_100_000],
    ['0.01', 10_000],
    ['-500', -500_000_000],
    ['125000', 125_000_000_000],
  ])('toMicros(%s) = %d (no float error)', (decimal, micros) => {
    expect(toMicros(decimal)).toBe(micros);
  });

  it('rejects more than 2 decimals and unsafe values', () => {
    expect(toMicros('1.005')).toBeUndefined();
    expect(toMicros('99999999999999')).toBeUndefined();
  });

  it.each([
    [12_500_100_000, '12500.10'],
    [10_000, '0.01'],
    [-500_000_000, '-500.00'],
    [0, '0.00'],
  ])('fromMicros(%d) = %s', (micros, text) => {
    expect(fromMicros(micros)).toBe(text);
  });
});

describe('dates', () => {
  it.each([
    ['05/10/2026', 'DMY', '2026-10-05'],
    ['5/10/2026', 'DMY', '2026-10-05'],
    ['05-10-2026', 'DMY', '2026-10-05'],
    ['05.10.2026', 'DMY', '2026-10-05'],
    ['05/10/26', 'DMY', '2026-10-05'],
    ['05/10/99', 'DMY', '1999-10-05'],
    ['10/05/2026', 'MDY', '2026-10-05'],
    ['2026-10-05', 'DMY', '2026-10-05'],
    ['2026/10/05', 'MDY', '2026-10-05'],
    ['2026-10-05T00:00:00Z', 'DMY', '2026-10-05'],
    ['2026-10-05 10:30:00', 'DMY', '2026-10-05'],
    ['05-Oct-2026', 'DMY', '2026-10-05'],
    ['05 oct 2026', 'DMY', '2026-10-05'],
    ['5-October-26', 'DMY', '2026-10-05'],
    ['29/02/2028', 'DMY', '2028-02-29'],
    ['46300', 'DMY', '2026-10-05'],
    ['45000', 'DMY', '2023-03-15'],
    ['1', 'DMY', '1900-01-01'],
    ['59', 'DMY', '1900-02-28'],
    ['61', 'DMY', '1900-03-01'],
  ])('%s (%s) → %s', (raw, format, iso) => {
    expect(parseDate(raw, format as 'DMY' | 'MDY')).toBe(iso);
  });

  it.each([
    ['31/04/2026'],
    ['29/02/2026'],
    ['2026-02-29'],
    ['13/13/2026'],
    ['00/10/2026'],
    ['05-Foo-2026'],
    ['tomorrow'],
    ['60'],
    ['0'],
    ['3000000'],
    ['2026-13-01'],
    ['1899-12-31'],
    ['05/10'],
  ])('%s → undefined', (raw) => {
    expect(parseDate(raw)).toBeUndefined();
  });

  it('reads JS Dates (from xlsx) by their UTC calendar day and Excel serial numbers', () => {
    expect(parseDate(new Date(Date.UTC(2026, 9, 5)))).toBe('2026-10-05');
    expect(parseDate(new Date('invalid'))).toBeUndefined();
    expect(parseDate(46300)).toBe('2026-10-05');
    expect(parseDate(true)).toBeUndefined();
    expect(excelSerialToIso(Number.NaN)).toBeUndefined();
    expect(toIsoDate(2101, 1, 1)).toBeUndefined();
  });
});

describe('parseFieldValue', () => {
  it.each([
    ['text', '  Pune  ', 'Pune'],
    ['text', 'आशा', 'आशा'],
    ['text', 42, '42'],
    ['number', '1,25,000', 125000],
    ['number', '-3.5', -3.5],
    ['number', 30, 30],
    ['currency', '₹ 12,500.10', 12_500_100_000],
    ['currency', 12500.5, 12_500_500_000],
    ['currency', 'Rs. 1,25,000/-', 125_000_000_000],
    ['date', '05/10/2026', '2026-10-05'],
    ['phone', '98765 43210', '+919876543210'],
  ] as const)('%s %j → %j', (type, raw, value) => {
    expect(parseFieldValue(type, raw)).toEqual({ ok: true, value });
  });

  it('treats blanks as absent for every type', () => {
    for (const type of ['text', 'number', 'currency', 'date', 'phone'] as const) {
      expect(parseFieldValue(type, '  ')).toEqual({ ok: true, value: undefined });
      expect(parseFieldValue(type, null)).toEqual({ ok: true, value: undefined });
    }
  });

  it.each([
    ['number', 'twelve'],
    ['number', '12,34'],
    ['currency', '12.345'],
    ['currency', 'free'],
    ['date', '31/02/2026'],
    ['phone', '12345'],
  ] as const)('%s %j → type_invalid', (type, raw) => {
    expect(parseFieldValue(type, raw)).toEqual({ ok: false, reason: 'type_invalid' });
  });

  it('limits text to 1000 characters and honours date / country options', () => {
    expect(parseFieldValue('text', 'x'.repeat(1001))).toEqual({ ok: false, reason: 'too_long' });
    expect(parseFieldValue('text', 'x'.repeat(1000)).ok).toBe(true);
    expect(parseFieldValue('text', new Date(Date.UTC(2026, 9, 5)))).toEqual({
      ok: true,
      value: '2026-10-05',
    });
    expect(parseFieldValue('date', '10/05/2026', { dateFormat: 'MDY' })).toEqual({
      ok: true,
      value: '2026-10-05',
    });
    expect(parseFieldValue('phone', '020 7946 0958', { country: 'GB' })).toEqual({
      ok: true,
      value: '+442079460958',
    });
  });
});

describe('formatFieldValue', () => {
  it('formats stored values for export', () => {
    expect(formatFieldValue('currency', 12_500_100_000)).toBe('12500.10');
    expect(formatFieldValue('number', 30)).toBe('30');
    expect(formatFieldValue('date', '2026-10-05')).toBe('2026-10-05');
    expect(formatFieldValue('text', undefined)).toBe('');
    expect(formatFieldValue('currency', null)).toBe('');
  });
});
