/**
 * PII masking for logs (docs/conventions/data.md §9).
 * Phone: keep "+" + first 2 chars of the number and the last 4 digits.
 */
export const maskPhone = (phone: string): string => {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length <= 6) return '*'.repeat(digits.length);
  const head = digits.startsWith('+') ? digits.slice(0, 3) : digits.slice(0, 2);
  const tail = digits.slice(-4);
  return `${head}${'*'.repeat(digits.length - head.length - tail.length)}${tail}`;
};

export const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
};
