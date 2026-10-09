import { AI_LIMITS } from '../../config/limits';

const LONG_NUMBER = /\+?\d[\d\s-]{5,}\d/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Masks phone-like numbers (keeps the last 4 digits) and e-mail local parts. */
export const redactText = (text: string): string =>
  text
    .replace(LONG_NUMBER, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 7 ? `••••${digits.slice(-4)}` : match;
    })
    .replace(EMAIL, (_all, domain: string) => `•••@${domain}`);

/** Tool arguments for the tool-call log: personal values masked, long strings cut. */
export const redactArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? redactText(value.slice(0, 200))
        : typeof value === 'number' || typeof value === 'boolean' || value === null
          ? value
          : redactText(JSON.stringify(value).slice(0, 200)),
    ]),
  );

/** First 500 chars of a result, redacted (tool-call log preview). */
export const redactPreview = (text: string): string =>
  redactText(text).slice(0, AI_LIMITS.toolResultPreviewChars);
