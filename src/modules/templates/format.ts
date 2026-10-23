import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { FieldType } from '../../db/models/custom-field.model';
import { formatInr } from '../../shared/money';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 6 });

/** `2026-10-05` → `05 Oct 2026` (date only, never shifted by a timezone). */
export const formatDateOnly = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3] ?? ''} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1] ?? ''}`;
};

/** `+919876543210` → `+91 98765 43210` (international format; unparsable stays). */
export const formatPhone = (e164: string): string =>
  parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;

/**
 * A contact value as text for a template variable — mirrors the frontend's
 * `formatFieldValue` (currency micros → `₹12,500.10`, date-only, numbers en-IN, phone).
 * Empty → null (the variable is missing). Shared cases: tests/fixtures/template-format-cases.json.
 */
export const formatVariableValue = (
  type: FieldType,
  value: string | number | null | undefined,
): string | null => {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'currency':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? formatInr(value)
        : String(value);
    case 'number':
      return typeof value === 'number' ? numberFormat.format(value) : String(value);
    case 'date':
      return formatDateOnly(String(value));
    case 'phone':
      return formatPhone(String(value));
    default:
      return String(value);
  }
};
