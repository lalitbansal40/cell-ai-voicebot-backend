import type { CountryCode } from 'libphonenumber-js';

import { CONTACT_LIMITS } from '../../../config/limits';
import type { VariableValue } from '../../../db/models/contact.model';
import type { FieldType } from '../../../db/models/custom-field.model';

import { normalizePhone } from './phone';

export type DateFormat = 'DMY' | 'MDY' | 'YMD';
export type ValueReason = 'type_invalid' | 'too_long';
/** `value: undefined` = empty cell / absent value. */
export type ValueResult =
  { ok: true; value: VariableValue | undefined } | { ok: false; reason: ValueReason };

export interface ParseOptions {
  dateFormat?: DateFormat;
  country?: CountryCode;
}

const MICROS_PER_UNIT = 1_000_000n;
const MAX_ABS_NUMBER = 1e15;

const isBlank = (raw: unknown): boolean =>
  raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

/** Western `1,250,000` or Indian `12,50,000` grouping of the integer part. */
const GROUPED = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3})$/;

/**
 * `₹ 1,25,000.50` / `Rs. 500/-` / `-12.5` → canonical decimal string, or
 * undefined. Commas must form a real grouping (so `12,34` is rejected,
 * not read as 1234).
 */
export const cleanDecimal = (raw: unknown): string | undefined => {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || Math.abs(raw) > MAX_ABS_NUMBER) return undefined;
    const text = String(raw);
    return /e/i.test(text) ? undefined : text;
  }
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim().replace(/\u00a0/g, ' ');
  let sign = '';
  if (/^[+-]/.test(text)) {
    sign = text[0] === '-' ? '-' : '';
    text = text.slice(1).trim();
  }
  text = text
    .replace(/^(₹|rs\.?|inr)\s*/i, '')
    .replace(/\s*(₹|rs\.?|inr|\/-)$/i, '')
    .trim();
  if (!sign && /^-/.test(text)) {
    sign = '-';
    text = text.slice(1).trim();
  }
  text = text.replace(/\s+/g, '');
  const [intPart = '', frac, ...rest] = text.split('.');
  if (rest.length > 0) return undefined;
  if (intPart.includes(',') && !GROUPED.test(intPart)) return undefined;
  const digits = intPart.replace(/,/g, '');
  if (!/^\d*$/.test(digits) || (frac !== undefined && !/^\d+$/.test(frac))) return undefined;
  if (!digits && !frac) return undefined;
  const value = `${sign}${digits || '0'}${frac !== undefined ? `.${frac}` : ''}`;
  return Math.abs(Number(value)) > MAX_ABS_NUMBER ? undefined : value;
};

/** Rupees (decimal string, ≤ 2 decimals) → integer micros without float rounding. */
export const toMicros = (decimal: string): number | undefined => {
  const negative = decimal.startsWith('-');
  const [int = '0', frac = ''] = decimal.replace(/^-/, '').split('.');
  if (frac.length > 2) return undefined;
  const micros = BigInt(int) * MICROS_PER_UNIT + BigInt(frac.padEnd(6, '0'));
  const result = Number(negative ? -micros : micros);
  return Number.isSafeInteger(result) ? result : undefined;
};

/** Integer micros → `12500.10` (export / form value). */
export const fromMicros = (micros: number): string => {
  const sign = micros < 0 ? '-' : '';
  const abs = BigInt(Math.abs(micros));
  const int = abs / MICROS_PER_UNIT;
  const cents = Number((abs % MICROS_PER_UNIT) / 10_000n);
  return `${sign}${int.toString()}.${String(cents).padStart(2, '0')}`;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Real calendar date (no 31/04, 29/02 only in leap years), years 1900–2100. */
export const toIsoDate = (y: number, m: number, d: number): string | undefined => {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
};

const fullYear = (y: string): number => {
  const n = Number(y);
  if (y.length !== 2) return n;
  return n < 70 ? 2000 + n : 1900 + n;
};

/** Excel day serial (1900 date system, with Excel's fake 1900-02-29 = serial 60). */
export const excelSerialToIso = (serial: number): string | undefined => {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465 || serial === 60)
    return undefined;
  const days = Math.floor(serial);
  const base = days > 60 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  const date = new Date(base + days * 86_400_000);
  return toIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};

/** Any supported date input → `YYYY-MM-DD` (date only — never shifted by a timezone). */
export const parseDate = (raw: unknown, format: DateFormat = 'DMY'): string | undefined => {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return undefined;
    return toIsoDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }
  if (typeof raw === 'number') return excelSerialToIso(raw);
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();

  if (/^\d{1,7}(\.\d+)?$/.test(text)) return excelSerialToIso(Number(text));

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ][\d:.]+Z?)?$/.exec(text);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const named = /^(\d{1,2})[-\s/.]([a-z]{3,9})[-\s/.,]+(\d{2}|\d{4})$/i.exec(text);
  if (named) {
    const [, day, monthName, year] = named as unknown as [string, string, string, string];
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return undefined;
    return toIsoDate(fullYear(year), month, Number(day));
  }

  const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (!parts) return undefined;
  const [, first, second, yearText] = parts as unknown as [string, string, string, string];
  const a = Number(first);
  const b = Number(second);
  const year = fullYear(yearText);
  if (format === 'MDY') return toIsoDate(year, a, b);
  return toIsoDate(year, b, a);
};

/**
 * Parses one field value by its type (PHASE_3_PLAN §1a): text ≤ 1000,
 * number, currency → integer micros, date → `YYYY-MM-DD`, phone → E.164.
 */
export const parseFieldValue = (
  type: FieldType,
  raw: unknown,
  options: ParseOptions = {},
): ValueResult => {
  if (isBlank(raw)) return { ok: true, value: undefined };
  switch (type) {
    case 'text': {
      const text = (raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw)).trim();
      if (text.length > CONTACT_LIMITS.textValueMaxLength) return { ok: false, reason: 'too_long' };
      return { ok: true, value: text };
    }
    case 'number': {
      const decimal = cleanDecimal(raw);
      return decimal === undefined
        ? { ok: false, reason: 'type_invalid' }
        : { ok: true, value: Number(decimal) };
    }
    case 'currency': {
      const decimal = cleanDecimal(raw);
      const micros = decimal === undefined ? undefined : toMicros(decimal);
      return micros === undefined
        ? { ok: false, reason: 'type_invalid' }
        : { ok: true, value: micros };
    }
    case 'date': {
      const iso = parseDate(raw, options.dateFormat);
      return iso === undefined ? { ok: false, reason: 'type_invalid' } : { ok: true, value: iso };
    }
    case 'phone': {
      const phone = normalizePhone(raw, options.country ?? 'IN');
      return phone.ok ? { ok: true, value: phone.e164 } : { ok: false, reason: 'type_invalid' };
    }
  }
};

/** Stored value → export / template text (currency in rupees, others as stored). */
export const formatFieldValue = (
  type: FieldType,
  stored: VariableValue | undefined | null,
): string => {
  if (stored === undefined || stored === null) return '';
  if (type === 'currency' && typeof stored === 'number') return fromMicros(stored);
  return String(stored);
};
