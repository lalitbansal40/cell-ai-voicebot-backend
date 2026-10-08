import { z } from 'zod';

export type EmailResult =
  { ok: true; value: string | undefined } | { ok: false; reason: 'email_invalid' };

const EMAIL = z.email().max(254);

/** Optional e-mail: blank → absent; otherwise trimmed, lower-cased, validated. */
export const normalizeEmail = (raw: unknown): EmailResult => {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, reason: 'email_invalid' };
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: true, value: undefined };
  return EMAIL.safeParse(value).success
    ? { ok: true, value }
    : { ok: false, reason: 'email_invalid' };
};
