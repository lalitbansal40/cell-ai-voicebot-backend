/** Auth limits and names (PHASE_2_PLAN §1a). */
export const ISSUER = 'cav';
export const ACCESS_AUDIENCE = 'cav-dashboard';
export const REFRESH_COOKIE = 'cav_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_MAX_SENDS_PER_HOUR = 5;
export const RESET_TTL_MS = 30 * 60_000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const IMPERSONATION_TTL = '30m';

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_WINDOW_SEC = 15 * 60;

/** Minimum time for signup / forgot-password responses (no account enumeration by timing). */
export const MIN_ENUMERATION_SAFE_MS = 300;

/** argon2id parameters (OWASP: m=19 MiB, t=2, p=1). */
export const ARGON2_PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
