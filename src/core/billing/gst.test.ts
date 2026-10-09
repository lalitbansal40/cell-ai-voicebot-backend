import { describe, expect, it } from 'vitest';

import { computeTopupTax } from './gst';
import { financialYear } from './invoice-number';

const RUPEE = 1_000_000;

describe('computeTopupTax', () => {
  it('splits CGST + SGST within a state', () => {
    expect(computeTopupTax(1000 * RUPEE, '08', '08')).toEqual({
      baseMicros: 1000 * RUPEE,
      cgstMicros: 90 * RUPEE,
      sgstMicros: 90 * RUPEE,
      igstMicros: 0,
      taxMicros: 180 * RUPEE,
      totalMicros: 1180 * RUPEE,
    });
  });

  it('uses IGST across states', () => {
    expect(computeTopupTax(1000 * RUPEE, '08', '27')).toMatchObject({
      cgstMicros: 0,
      sgstMicros: 0,
      igstMicros: 180 * RUPEE,
      totalMicros: 1180 * RUPEE,
    });
  });

  it.each([
    // base rupees, intra-state CGST each (paise-rounded), IGST
    [100, 9_000_000, 18_000_000],
    [999, 89_910_000, 179_820_000],
    [1234, 111_060_000, 222_120_000],
    [101, 9_090_000, 18_180_000],
  ])('rounds each component to paise for ₹%i', (rupees, cgst, igst) => {
    const intra = computeTopupTax(rupees * RUPEE, '08', '08');
    expect(intra.cgstMicros).toBe(cgst);
    expect(intra.sgstMicros).toBe(cgst);
    expect(intra.cgstMicros % 10_000).toBe(0);
    expect(computeTopupTax(rupees * RUPEE, '08', '29').igstMicros).toBe(igst);
  });

  it('rounds odd paise half up per component', () => {
    // ₹0.05 base: 9 % = 0.45 paise → 0; 18 % = 0.9 paise → 1 paisa
    const intra = computeTopupTax(50_000, '08', '08');
    expect(intra.cgstMicros).toBe(0);
    expect(computeTopupTax(50_000, '08', '27').igstMicros).toBe(10_000);
    expect(() => computeTopupTax(-1, '08', '08')).toThrow();
  });
});

describe('financialYear (IST)', () => {
  it.each([
    ['2026-04-01T00:00:00+05:30', '26-27'],
    ['2026-03-31T23:59:59+05:30', '25-26'],
    ['2027-03-31T18:29:59Z', '26-27'], // 23:59:59 IST
    ['2027-03-31T18:30:00Z', '27-28'], // 00:00 IST on 1 April
    ['2099-12-31T00:00:00Z', '99-00'],
  ])('%s → %s', (iso, fy) => {
    expect(financialYear(new Date(iso))).toBe(fy);
  });
});
