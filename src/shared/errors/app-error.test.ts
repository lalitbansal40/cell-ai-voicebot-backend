import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  isAppError,
  NotFoundError,
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from './app-error';

describe('AppError family', () => {
  it.each([
    [new ValidationError([{ path: 'phone', message: 'bad' }]), 'VALIDATION_FAILED', 422],
    [new NotFoundError(), 'RESOURCE_NOT_FOUND', 404],
    [new ConflictError(), 'CONFLICT_DUPLICATE', 409],
    [new ConflictError('CONFLICT_INVALID_STATE'), 'CONFLICT_INVALID_STATE', 409],
    [new UnauthenticatedError(), 'AUTH_UNAUTHENTICATED', 401],
    [new UnauthenticatedError('AUTH_TOKEN_EXPIRED'), 'AUTH_TOKEN_EXPIRED', 401],
    [new ForbiddenError(), 'AUTH_FORBIDDEN', 403],
    [new RateLimitedError(), 'RATE_LIMITED', 429],
    [new PayloadTooLargeError(), 'PAYLOAD_TOO_LARGE', 413],
    [new ProviderError(), 'PROVIDER_ERROR', 502],
    [new ProviderError('PROVIDER_UNAVAILABLE'), 'PROVIDER_UNAVAILABLE', 503],
  ])('%s → %s / %i', (err, code, status) => {
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.expose).toBe(status < 500);
    expect(isAppError(err)).toBe(true);
    expect(err.name).toBe(err.constructor.name);
  });

  it('uses the catalogue message by default and accepts a custom one', () => {
    expect(new NotFoundError().message).toBe('Resource not found.');
    expect(new NotFoundError('Contact not found').message).toBe('Contact not found');
  });

  it('keeps validation details', () => {
    expect(new ValidationError([{ path: 'a', message: 'b' }]).details).toEqual([
      { path: 'a', message: 'b' },
    ]);
  });

  it('keeps the cause', () => {
    const cause = new Error('socket hang up');
    expect(new ProviderError('PROVIDER_ERROR', undefined, { cause }).cause).toBe(cause);
  });

  it('isAppError rejects plain errors', () => {
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(new AppError('INTERNAL_ERROR'))).toBe(true);
  });
});
