import { describe, expect, it } from 'vitest';

import {
  amountInWords,
  assertMicros,
  ceilDiv,
  formatInr,
  formatRupees,
  isMicros,
  microsToPaise,
  mulBps,
  numberInWords,
  paiseToMicros,
  roundDiv,
  roundToPaise,
  rupeesToMicros,
} from './money';

describe('money helpers', () => {
  it('validates micros', () => {
    expect(assertMicros(5)).toBe(5);
    expect(assertMicros(-5, { allowNegative: true })).toBe(-5);
    expect(() => assertMicros(-1)).toThrow(/Negative/);
    expect(() => assertMicros(1.5)).toThrow(/safe integer/);
    expect(() => assertMicros(2 ** 60)).toThrow(/safe integer/);
    expect(isMicros(10)).toBe(true);
    expect(isMicros('10')).toBe(false);
    expect(isMicros(0.1)).toBe(false);
  });

  it('divides with integer rounding', () => {
    expect(ceilDiv(0, 60)).toBe(0);
    expect(ceilDiv(-5, 60)).toBe(0);
    expect(ceilDiv(1, 60)).toBe(1);
    expect(ceilDiv(60, 60)).toBe(1);
    expect(ceilDiv(61, 60)).toBe(2);
    expect(() => ceilDiv(1, 0)).toThrow();
    expect(roundDiv(5, 10)).toBe(1);
    expect(roundDiv(4, 10)).toBe(0);
    expect(roundDiv(15, 10)).toBe(2);
    expect(roundDiv(-15, 10)).toBe(-2);
    expect(() => roundDiv(1, -1)).toThrow();
  });

  it('applies basis points half up', () => {
    expect(mulBps(1_000_000, 1800)).toBe(180_000);
    expect(mulBps(1, 5000)).toBe(1); // 0.5 → 1
    expect(mulBps(1, 4999)).toBe(0);
    expect(mulBps(0, 1800)).toBe(0);
    expect(mulBps(-1_000_000, 1500)).toBe(-150_000);
  });

  it('converts paise', () => {
    expect(microsToPaise(1_000_000)).toBe(100);
    expect(microsToPaise(10_000)).toBe(1);
    expect(() => microsToPaise(5_000)).toThrow(/paisa/);
    expect(paiseToMicros(118_000)).toBe(1_180_000_000);
    expect(() => paiseToMicros(1.5)).toThrow();
    expect(roundToPaise(14_999)).toBe(10_000);
    expect(roundToPaise(15_000)).toBe(20_000);
  });

  it.each([
    ['1', 1_000_000],
    ['1,25,000.50', 125_000_500_000],
    ['125,000.5', 125_000_500_000],
    ['₹ 500', 500_000_000],
    ['0.01', 10_000],
    ['12,34,56,789', 123_456_789_000_000],
    ['  7  ', 7_000_000],
  ])('parses rupees %s', (input, micros) => {
    expect(rupeesToMicros(input)).toBe(micros);
  });

  it.each(['', 'abc', '-5', '1.234', '1,2,3', '1e3', '₹', '99999999999999999999'])(
    'refuses %s',
    (input) => {
      expect(rupeesToMicros(input)).toBeNull();
    },
  );

  it('formats rupees with Indian grouping', () => {
    expect(formatRupees(0)).toBe('0.00');
    expect(formatRupees(1_180_000_000)).toBe('1,180.00');
    expect(formatRupees(125_000_500_000)).toBe('1,25,000.50');
    expect(formatRupees(12_345_678_900_000)).toBe('1,23,45,678.90');
    expect(formatRupees(5_000)).toBe('0.01'); // half paisa rounds up
    expect(formatRupees(-2_000_000)).toBe('-2.00');
    expect(formatRupees(-1)).toBe('0.00');
    expect(formatInr(1_000_000_000)).toBe('₹1,000.00');
    expect(formatInr(-2_000_000)).toBe('-₹2.00');
  });

  it('writes numbers and amounts in words (Indian system)', () => {
    expect(numberInWords(0)).toBe('Zero');
    expect(numberInWords(7)).toBe('Seven');
    expect(numberInWords(19)).toBe('Nineteen');
    expect(numberInWords(40)).toBe('Forty');
    expect(numberInWords(500)).toBe('Five Hundred');
    expect(numberInWords(1005)).toBe('One Thousand Five');
    expect(numberInWords(1180)).toBe('One Thousand One Hundred Eighty');
    expect(numberInWords(125_000)).toBe('One Lakh Twenty Five Thousand');
    expect(numberInWords(10_000_000)).toBe('One Crore');
    expect(numberInWords(1_234_567_890)).toBe(
      'One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety',
    );
    expect(() => numberInWords(-1)).toThrow();
    expect(() => numberInWords(1.5)).toThrow();
    expect(amountInWords(1_180_000_000)).toBe('Rupees One Thousand One Hundred Eighty Only');
    expect(amountInWords(1_180_500_000)).toBe(
      'Rupees One Thousand One Hundred Eighty and Fifty Paise Only',
    );
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});
