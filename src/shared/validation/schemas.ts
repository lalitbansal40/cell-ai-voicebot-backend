import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { z } from '../openapi/zod';

/**
 * Shared request schemas (docs/conventions/api.md). Built on the OpenAPI-extended
 * `z` so they can be registered as components later.
 */

export const ObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a 24-character id');

/** Offset pagination: page ≥ 1 (default 1), limit 1–100 (default 20). */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Cursor pagination: opaque base64url cursor, limit 1–100 (default 50). */
export const CursorQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface SortField<F extends string = string> {
  field: F;
  direction: 'asc' | 'desc';
}

/** `?sort=-createdAt,name` → `[{ field: 'createdAt', direction: 'desc' }, …]`, allowlisted fields only. */
export const sortSchema = <F extends string>(allowlist: readonly F[], defaultSort = '-createdAt') =>
  z
    .string()
    .default(defaultSort)
    .transform((value, ctx): SortField<F>[] => {
      const parts = value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const seen = new Set<string>();
      const out: SortField<F>[] = [];
      for (const part of parts) {
        const field = part.replace(/^-/, '');
        if (!(allowlist as readonly string[]).includes(field)) {
          ctx.addIssue({
            code: 'custom',
            message: `Cannot sort by "${field}". Allowed: ${allowlist.join(', ')}`,
          });
          return z.NEVER;
        }
        if (seen.has(field)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate sort field "${field}"` });
          return z.NEVER;
        }
        seen.add(field);
        out.push({ field: field as F, direction: part.startsWith('-') ? 'desc' : 'asc' });
      }
      return out;
    });

/** Any common phone format → E.164 (default region IN, ADR 0018). */
export const PhoneE164Schema = z.string().transform((value, ctx) => {
  const parsed = parsePhoneNumberFromString(value, 'IN');
  if (!parsed?.isValid()) {
    ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
    return z.NEVER;
  }
  return parsed.number;
});

/** Money in integer micro-units (ADR 0016). */
export const MoneyMicrosSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Query objects reject unknown params (api.md §8). */
export const strictQuery = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);
