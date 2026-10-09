import { isGstStateCode } from './gst-states';

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Check character of the first 14 GSTIN characters (mod-36, weights 1 / 2 alternating). */
export const gstinCheckChar = (first14: string): string => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14.charAt(i));
    if (value < 0) throw new RangeError('Bad GSTIN character');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET.charAt((36 - (sum % 36)) % 36);
};

export type GstinProblem = 'format' | 'checksum' | 'state';

/** `null` when valid; otherwise why not. `stateCode` → the first 2 digits must match it. */
export const gstinProblem = (gstin: string, stateCode?: string): GstinProblem | null => {
  if (!GSTIN_PATTERN.test(gstin) || !isGstStateCode(gstin.slice(0, 2))) return 'format';
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'checksum';
  if (stateCode !== undefined && gstin.slice(0, 2) !== stateCode) return 'state';
  return null;
};

export const isValidGstin = (gstin: string, stateCode?: string): boolean =>
  gstinProblem(gstin, stateCode) === null;

/** Builds a valid-format GSTIN (fixtures / seed only): state + PAN-like + entity + Z + check. */
export const makeGstin = (stateCode: string, pan = 'AAAAA0000A', entity = '1'): string => {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return `${first14}${gstinCheckChar(first14)}`;
};
