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

/**
 * `/auth/refresh` runs on every page load and tab (and every ~14 min), and is
 * authenticated by an unguessable httpOnly cookie — so it gets far more room
 * than the brute-forceable routes. Same window, per IP.
 */
export const AUTH_REFRESH_RATE_LIMIT = 600;

/** Contacts, imports and exports (PHASE_3_PLAN §1e). */
export const CONTACT_LIMITS = {
  importMaxBytes: 10 * 1024 * 1024,
  importMaxRows: 50_000,
  importMaxColumns: 100,
  /** Sum of uncompressed entry sizes in an .xlsx (zip-bomb guard). */
  xlsxMaxUncompressedBytes: 100 * 1024 * 1024,
  importBatchSize: 500,
  importSampleRows: 20,
  importSampleValues: 3,
  problemRowsInline: 100,
  customFieldsPerAccount: 50,
  listsPerAccount: 500,
  segmentsPerAccount: 100,
  segmentConditions: 20,
  tagsPerContact: 20,
  listsPerContact: 50,
  textValueMaxLength: 1000,
  bulkIdsMax: 1000,
  bulkFilterMax: 100_000,
  exportMaxRows: 100_000,
  exportBatchSize: 1000,
  progressThrottleMs: 1000,
  exportUrlTtlSec: 900,
  exportRetentionHours: 24,
  importFileRetentionDays: 30,
  deletedContactRetentionDays: 30,
  /** Redis lock TTL for one running import / bulk / export per account. */
  jobLockTtlMs: 30 * 60_000,
} as const;
