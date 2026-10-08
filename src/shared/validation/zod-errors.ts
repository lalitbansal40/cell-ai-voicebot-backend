import type { core } from 'zod';

import type { ErrorDetail } from '../errors/app-error';

/** zod issues → API error details (`path` joined with dots, prefixed per request part). */
export const zodIssuesToDetails = (
  issues: readonly core.$ZodIssue[],
  prefix?: string,
): ErrorDetail[] =>
  issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter((p) => p !== undefined && p !== '').join('.'),
    message: issue.message,
  }));
