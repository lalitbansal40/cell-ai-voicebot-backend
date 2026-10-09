import { describe, expect, it } from 'vitest';

import { GST_STATE_CODES, GST_STATES, gstStateName, isGstStateCode } from './gst-states';
import { gstinCheckChar, gstinProblem, isValidGstin, makeGstin } from './gstin';

describe('GST states', () => {
  it('lists unique two-digit codes incl. merged 26, Ladakh 38 and Other Territory 97', () => {
    expect(new Set(GST_STATE_CODES).size).toBe(GST_STATES.length);
    expect(GST_STATE_CODES.every((c) => /^\d{2}$/.test(c))).toBe(true);
    for (const code of ['08', '26', '27', '38', '97']) expect(isGstStateCode(code)).toBe(true);
    expect(isGstStateCode('25')).toBe(false);
    expect(isGstStateCode('99')).toBe(false);
    expect(gstStateName('08')).toBe('Rajasthan');
    expect(gstStateName('99')).toBe('99');
  });
});

describe('GSTIN', () => {
  it('computes the mod-36 check character', () => {
    // Public example GSTIN format with a known check digit.
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(() => gstinCheckChar('27aapfu0939f1z')).toThrow();
  });

  it('validates format, checksum and state', () => {
    const valid = makeGstin('08');
    expect(valid).toHaveLength(15);
    expect(isValidGstin(valid)).toBe(true);
    expect(isValidGstin(valid, '08')).toBe(true);
    expect(gstinProblem(valid, '27')).toBe('state');
    expect(gstinProblem('27AAPFU0939F1ZV')).toBeNull();
    expect(gstinProblem('27AAPFU0939F1ZA')).toBe('checksum');
    expect(gstinProblem('27AAPFU0939F1Z')).toBe('format');
    expect(gstinProblem('99AAPFU0939F1ZV')).toBe('format');
    expect(gstinProblem('27aapfu0939f1zv')).toBe('format');
    expect(makeGstin('27', 'BBBBB1111B', '2')).toMatch(/^27BBBBB1111B2Z.$/);
  });
});
