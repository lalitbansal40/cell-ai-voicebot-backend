import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * PII masking for logs (docs/conventions/data.md §9).
 * Phone: keep "+<country code>" and the last 4 digits → "+91******3210".
 */
export const maskPhone = (phone: string): string => {
  const compact = phone.replace(/[^\d+]/g, '');
  if (compact.replace('+', '').length <= 6) return '*'.repeat(compact.length);
  const parsed = parsePhoneNumberFromString(compact, 'IN');
  const head = parsed ? `+${parsed.countryCallingCode}` : compact.slice(0, 3);
  const full = parsed ? parsed.number : compact;
  const tail = full.slice(-4);
  return `${head}${'*'.repeat(Math.max(0, full.length - head.length - tail.length))}${tail}`;
};

export const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
};
