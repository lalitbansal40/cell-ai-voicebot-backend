import type { ZodType } from 'zod';

import { ErrorEnvelopeSchema, successEnvelope } from './common.schemas';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorEnvelopeSchema } },
});

/** Standard error responses for documented routes. */
export const errors = {
  401: error('Missing / invalid / expired token (AUTH_UNAUTHENTICATED, AUTH_TOKEN_EXPIRED)'),
  403: error('Missing permission, disabled user, suspended account or impersonation block'),
  404: error('Not found in this account (RESOURCE_NOT_FOUND)'),
  409: error('Conflict (CONFLICT_DUPLICATE / CONFLICT_INVALID_STATE)'),
  422: error('Validation failed / invalid code (VALIDATION_FAILED, AUTH_CODE_INVALID)'),
  429: error(
    'Rate limited / too many attempts (RATE_LIMITED, AUTH_TOO_MANY_ATTEMPTS) — see Retry-After',
  ),
} as const;

export const ok = <T extends ZodType>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema: successEnvelope(schema) } },
});

export const noContentResponse = { description: 'No content' };

/** Dashboard (Bearer) security requirement. */
export const bearer = [{ bearerAuth: [] as string[] }];
/** Public API key security requirement. */
export const apiKey = [{ apiKeyAuth: [] as string[] }];
