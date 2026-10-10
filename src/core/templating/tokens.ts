/** Any `{{ … }}` placeholder (valid or not). */
const ANY_TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Every `{{token}}` in a text (valid or not), trimmed. */
export const templateTokens = (text: string): string[] =>
  [...text.matchAll(ANY_TOKEN)].map((m) => m[1] ?? '');

/** Strings as-is, numbers / booleans as text, anything else → `''`. */
export const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

/** Missing = `undefined`, `null` or `''` (rendered as `''` with a `missing:<token>` warning). */
export const isMissing = (value: unknown): boolean =>
  value === undefined || value === null || value === '';
