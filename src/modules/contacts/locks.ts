import { getEnv } from '../../config/env';
import { CONTACT_LIMITS } from '../../config/limits';
import { getAppRedis } from '../../core/queues/redis';
import { getLogger } from '../../shared/logger';

const redis = () => getAppRedis(getEnv().REDIS_URL, getLogger());

export type JobLockKind = 'import' | 'bulk' | 'export';

/** One running import / bulk / export per account (PHASE_3_PROMPT §1 "Locks"). */
export const jobLockKey = (kind: JobLockKind, accountId: string): string =>
  kind === 'import'
    ? `contacts:import-lock:${accountId}`
    : `contacts:job-lock:${accountId}:${kind}`;

/** True when `owner` now holds the lock. */
export const acquireJobLock = async (
  kind: JobLockKind,
  accountId: string,
  owner: string,
  ttlMs: number = CONTACT_LIMITS.jobLockTtlMs,
): Promise<boolean> => {
  const key = jobLockKey(kind, accountId);
  if ((await redis().set(key, owner, 'PX', ttlMs, 'NX')) === 'OK') return true;
  return (await redis().get(key)) === owner; // the same job retrying keeps its lock
};

const REFRESH = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export const refreshJobLock = async (
  kind: JobLockKind,
  accountId: string,
  owner: string,
  ttlMs: number = CONTACT_LIMITS.jobLockTtlMs,
): Promise<void> => {
  await redis().eval(REFRESH, 1, jobLockKey(kind, accountId), owner, String(ttlMs));
};

/** Releases only our own lock. */
export const releaseJobLock = async (
  kind: JobLockKind,
  accountId: string,
  owner: string,
): Promise<void> => {
  await redis().eval(RELEASE, 1, jobLockKey(kind, accountId), owner);
};
