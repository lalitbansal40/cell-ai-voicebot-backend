/**
 * Error code catalogue — single source of truth in code.
 * MUST match docs/conventions/error-codes.md (enforced by error-codes.test.ts).
 * `message` is the default, user-safe text; callers may pass a more specific one.
 */
export const ERROR_CODES = {
  REQUEST_MALFORMED: { status: 400, message: 'The request could not be parsed.' },
  VALIDATION_FAILED: { status: 422, message: 'Some fields are invalid.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The request is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Unsupported content or file type.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Please try again later.' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    message: 'This Idempotency-Key was already used with a different request.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    message: 'A request with this Idempotency-Key is still being processed.',
  },
  RESOURCE_NOT_FOUND: { status: 404, message: 'Resource not found.' },
  CONFLICT_DUPLICATE: { status: 409, message: 'This resource already exists.' },
  CONFLICT_INVALID_STATE: {
    status: 409,
    message: 'This action is not allowed in the current state.',
  },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong. Please try again.' },
  AUTH_UNAUTHENTICATED: { status: 401, message: 'Authentication required.' },
  AUTH_TOKEN_EXPIRED: { status: 401, message: 'Your session has expired. Please sign in again.' },
  AUTH_INVALID_CREDENTIALS: { status: 401, message: 'Invalid email or password.' },
  AUTH_FORBIDDEN: { status: 403, message: 'You do not have permission to do this.' },
  AUTH_EMAIL_NOT_VERIFIED: { status: 403, message: 'Please verify your email address first.' },
  AUTH_ACCOUNT_SUSPENDED: {
    status: 403,
    message: 'This account is suspended. Changes are not allowed.',
  },
  AUTH_USER_DISABLED: { status: 403, message: 'Your access to this account has been disabled.' },
  AUTH_SESSION_REVOKED: { status: 401, message: 'Your session has ended. Please sign in again.' },
  AUTH_CODE_INVALID: { status: 422, message: 'The code or link is invalid or has expired.' },
  AUTH_TOO_MANY_ATTEMPTS: { status: 429, message: 'Too many attempts. Please try again later.' },
  AUTH_IMPERSONATION_BLOCKED: {
    status: 403,
    message: 'This action is not allowed while viewing as another user.',
  },
  IMPORT_FILE_INVALID: {
    status: 422,
    message: 'The file could not be read as a contact sheet.',
  },
  CONTACT_DND: { status: 422, message: 'This contact is on the do-not-call list.' },
  CONTACT_OPTED_OUT: { status: 422, message: 'This contact has opted out of calls.' },
  WALLET_INSUFFICIENT_BALANCE: { status: 422, message: 'Insufficient wallet balance.' },
  WALLET_BUDGET_EXCEEDED: { status: 422, message: 'Monthly spend budget reached.' },
  BILLING_PROFILE_REQUIRED: {
    status: 422,
    message: 'Add your billing details before adding money.',
  },
  PAYMENT_VERIFICATION_FAILED: {
    status: 422,
    message: 'The payment could not be verified.',
  },
  AI_UNAVAILABLE: { status: 503, message: 'The voice AI service is unavailable.' },
  FLOW_INVALID: { status: 422, message: 'The call flow is invalid.' },
  CALL_OUTSIDE_WINDOW: { status: 422, message: 'Calls are not allowed at this time.' },
  CAMPAIGN_NOT_RUNNABLE: { status: 409, message: 'This campaign cannot be started.' },
  PROVIDER_UNAVAILABLE: { status: 503, message: 'An external provider is unavailable.' },
  PROVIDER_ERROR: { status: 502, message: 'An external provider returned an error.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
