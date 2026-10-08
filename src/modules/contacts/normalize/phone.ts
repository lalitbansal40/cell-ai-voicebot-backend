import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type PhoneReason = 'phone_missing' | 'phone_invalid' | 'phone_lost_digits';
export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: PhoneReason };

/** `9.87654E+09` — Excel turned the number into scientific notation and dropped digits. */
const SCIENTIFIC = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i;
/** Separators people type: spaces, dashes, dots, brackets, slashes. */
const SEPARATORS = /[\s\-.()/\u00a0]/g;

const fromNumber = (raw: number): string | undefined =>
  Number.isSafeInteger(raw) && raw > 0 ? String(raw) : undefined;

/**
 * Any phone a person or a spreadsheet may produce → E.164 (ADR 0018).
 * `defaultCountry` = the account's country (IN): `9876543210`, `09876543210`,
 * `+91 98765-43210`, `919876543210`, `0091…` all become `+919876543210`.
 */
export const normalizePhone = (raw: unknown, defaultCountry: CountryCode = 'IN'): PhoneResult => {
  if (raw === null || raw === undefined) return { ok: false, reason: 'phone_missing' };
  let text: string;
  if (typeof raw === 'number') {
    const asText = fromNumber(raw);
    if (!asText) {
      return {
        ok: false,
        reason:
          Number.isFinite(raw) && !Number.isInteger(raw) ? 'phone_lost_digits' : 'phone_invalid',
      };
    }
    text = asText;
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: 'phone_invalid' };
  }

  text = text.trim().replace(/^'+/, '').trim();
  if (!text) return { ok: false, reason: 'phone_missing' };
  if (SCIENTIFIC.test(text.replace(/,/g, ''))) return { ok: false, reason: 'phone_lost_digits' };
  if (/[a-z]/i.test(text)) return { ok: false, reason: 'phone_invalid' };

  let compact = text.replace(/\(0\)/g, '').replace(SEPARATORS, '');
  if (/^\d+\.0+$/.test(text)) compact = text.replace(/\.0+$/, '');
  if (!/^\+?\d+$/.test(compact)) return { ok: false, reason: 'phone_invalid' };
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;

  const candidates = compact.startsWith('+') ? [compact] : [compact, `+${compact}`];
  for (const candidate of candidates) {
    const parsed = candidate.startsWith('+')
      ? parsePhoneNumberFromString(candidate)
      : parsePhoneNumberFromString(candidate, defaultCountry);
    if (parsed?.isValid()) return { ok: true, e164: parsed.number };
  }
  return { ok: false, reason: 'phone_invalid' };
};

/** Digits only (search: any typed format finds the contact). */
export const phoneDigits = (text: string): string => text.replace(/\D/g, '');
