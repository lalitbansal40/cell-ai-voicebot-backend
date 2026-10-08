import { getEnv } from '../../config/env';
import { getAppRedis } from '../../core/queues/redis';
import { TooManyAttemptsError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import { LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_SEC } from './auth.constants';
import { sha256Hex } from './hmac';

/** Redis key per e-mail (hashed — no PII in Redis keys). */
export const lockKey = (email: string): string =>
  `auth:lock:${sha256Hex(email.trim().toLowerCase())}`;

const redis = () => getAppRedis(getEnv().REDIS_URL, getLogger());

/** 5 failed logins within 15 min → 429 AUTH_TOO_MANY_ATTEMPTS with Retry-After = remaining window. */
export const assertNotLocked = async (email: string): Promise<void> => {
  const key = lockKey(email);
  const [count, ttl] = await Promise.all([redis().get(key), redis().ttl(key)]);
  if (Number(count ?? 0) >= LOCKOUT_THRESHOLD) {
    throw new TooManyAttemptsError(ttl > 0 ? ttl : LOCKOUT_WINDOW_SEC);
  }
};

/** Counts a failed login; the window starts with the first failure. */
export const registerFailedLogin = async (email: string): Promise<number> => {
  const key = lockKey(email);
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, LOCKOUT_WINDOW_SEC);
  return count;
};

export const clearFailedLogins = async (email: string): Promise<void> => {
  await redis().del(lockKey(email));
};
