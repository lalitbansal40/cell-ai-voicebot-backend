import { INBOX_LIMITS } from '../../config/limits';

/**
 * Opt-out / opt-in keyword matching (PHASE_10_PLAN §1g, owner decision §7 #3):
 * the WHOLE message, after NFC, trimming, collapsing spaces, dropping trailing
 * punctuation (`. ! ? ।`) and emoji, upper-casing Latin letters. "band karo!" and
 * "बंद करो।" match `BAND KARO` / `बंद करो`; "mera order band karo mat" does not.
 */
const TRAILING = /(?:[\s.!?।॥,;:]|\p{Extended_Pictographic}|\u200d|\ufe0f)+$/u;
const LEADING = /^(?:\s|\p{Extended_Pictographic}|\u200d|\ufe0f)+/u;

export const normalizeKeyword = (value: string): string =>
  value
    .normalize('NFC')
    .replace(LEADING, '')
    .replace(TRAILING, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

export type KeywordMatch = 'opt_out' | 'opt_in' | null;

/** Longer than any keyword → never a keyword (cheap exit for normal chat). */
const MAX_INPUT = INBOX_LIMITS.keywordMaxLength * 2;

export const matchKeyword = (
  text: string | null | undefined,
  lists: { optOutKeywords: readonly string[]; optInKeywords: readonly string[] },
): KeywordMatch => {
  if (!text || text.length > MAX_INPUT) return null;
  const value = normalizeKeyword(text);
  if (!value) return null;
  if (lists.optOutKeywords.some((k) => normalizeKeyword(k) === value)) return 'opt_out';
  if (lists.optInKeywords.some((k) => normalizeKeyword(k) === value)) return 'opt_in';
  return null;
};
