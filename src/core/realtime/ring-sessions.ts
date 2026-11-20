import type { Redis } from 'ioredis';

/**
 * SAC D6: login-as sessions never ring for an account's incoming calls — unless a superadmin
 * full access session switched on "Ring me too". One key per session (expires with it) and a
 * set per account to find them; stale set members are dropped on read.
 */

export const ringMeTooKey = (sessionId: string): string => `auth:ringme:${sessionId}`;
const accountKey = (accountId: string): string => `auth:ringme:acct:${accountId}`;

export const setRingSession = async (
  redis: Redis,
  input: { accountId: string; sessionId: string; impersonatorId: string; ttlMs: number },
): Promise<void> => {
  await redis.set(ringMeTooKey(input.sessionId), input.impersonatorId, 'PX', input.ttlMs);
  await redis.sadd(accountKey(input.accountId), input.sessionId);
  await redis.pexpire(accountKey(input.accountId), Math.max(input.ttlMs, 60_000));
};

export const clearRingSession = async (
  redis: Redis,
  input: { accountId: string; sessionId: string },
): Promise<void> => {
  await redis.del(ringMeTooKey(input.sessionId));
  await redis.srem(accountKey(input.accountId), input.sessionId);
};

export const isRingSession = async (redis: Redis, sessionId: string): Promise<boolean> =>
  (await redis.exists(ringMeTooKey(sessionId))) === 1;

/** Sessions of the account with "Ring me too" on right now. */
export const ringSessionsOf = async (redis: Redis, accountId: string): Promise<string[]> => {
  const members = await redis.smembers(accountKey(accountId));
  const live: string[] = [];
  for (const sid of members) {
    if (await isRingSession(redis, sid)) live.push(sid);
    else await redis.srem(accountKey(accountId), sid);
  }
  return live;
};

/** Presence member marker of a login-as socket: `<userId>:imp:<sessionId>:<socketId>`. */
export const impersonationSocketId = (sessionId: string, socketId: string): string =>
  `imp:${sessionId}:${socketId}`;
