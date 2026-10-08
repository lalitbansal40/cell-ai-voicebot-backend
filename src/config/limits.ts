/** Request-size and rate limits (docs/conventions/api.md §11, PHASE_1_PLAN T1.6). */
export const JSON_BODY_LIMIT = '1mb';
export const URLENCODED_BODY_LIMIT = '100kb';

/** Global per-IP limit for every API request. */
export const GLOBAL_RATE_LIMIT = { windowMs: 60_000, limit: 300 } as const;

/** Preset for sensitive routes (login, password reset, OTP) — mounted in Phase 2. */
export const STRICT_RATE_LIMIT = { windowMs: 15 * 60_000, limit: 10 } as const;

/** Paths never rate-limited or access-logged (health checks land in T1.9). */
export const UNLIMITED_PATHS: readonly string[] = ['/health', '/ready'];

/** Default lifetime of signed download URLs (seconds). */
export const SIGNED_URL_TTL_SEC = 900;

/**
 * Public auth routes (signup, OTP, login, refresh, reset, accept invite):
 * per IP **and** route. Generous enough for an office behind one NAT;
 * brute force is stopped by the per-email lockout and OTP attempt caps.
 */
export const AUTH_RATE_LIMIT = { windowMs: 15 * 60_000, limit: 30 } as const;
