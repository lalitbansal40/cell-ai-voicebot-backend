import { ERROR_CODES, type ErrorCode } from './error-codes';

/** Field-level validation detail (docs/conventions/api.md §4). */
export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * Base class for every expected error. Carries a catalogued code, HTTP status,
 * a user-safe message and optional field details. 5xx messages are never exposed.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];
  /** False for 5xx: the client gets the generic catalogue message instead. */
  readonly expose: boolean;
  /** Sent as `Retry-After` (seconds) by the error handler. */
  readonly retryAfterSec?: number;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: ErrorDetail[],
    options?: { cause?: unknown; retryAfterSec?: number },
  ) {
    const entry = ERROR_CODES[code];
    super(message ?? entry.message, options);
    this.name = new.target.name;
    this.code = code;
    this.status = entry.status;
    this.details = details;
    this.expose = entry.status < 500;
    this.retryAfterSec = options?.retryAfterSec;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message?: string) {
    super('VALIDATION_FAILED', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message?: string) {
    super('RESOURCE_NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(
    code: 'CONFLICT_DUPLICATE' | 'CONFLICT_INVALID_STATE' = 'CONFLICT_DUPLICATE',
    message?: string,
  ) {
    super(code, message);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    code:
      | 'AUTH_UNAUTHENTICATED'
      | 'AUTH_TOKEN_EXPIRED'
      | 'AUTH_INVALID_CREDENTIALS'
      | 'AUTH_SESSION_REVOKED' = 'AUTH_UNAUTHENTICATED',
    message?: string,
  ) {
    super(code, message);
  }
}

/** Lockout / attempt caps / resend cooldown → 429 with `Retry-After`. */
export class TooManyAttemptsError extends AppError {
  constructor(retryAfterSec: number, message?: string) {
    super('AUTH_TOO_MANY_ATTEMPTS', message, undefined, {
      retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)),
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message?: string) {
    super('AUTH_FORBIDDEN', message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message?: string) {
    super('RATE_LIMITED', message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message?: string) {
    super('PAYLOAD_TOO_LARGE', message);
  }
}

export class ProviderError extends AppError {
  constructor(
    code: 'PROVIDER_ERROR' | 'PROVIDER_UNAVAILABLE' | 'AI_UNAVAILABLE' = 'PROVIDER_ERROR',
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, undefined, options);
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
