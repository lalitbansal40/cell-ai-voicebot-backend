import type { Redis } from 'ioredis';

import { ringSessionsOf } from './ring-sessions';

const TTL_MS = 90_000;
const key = (accountId: string) => `call:presence:${accountId}`;

/** A lease per socket: closing one tab cannot make a user's other tabs go offline. */
export const touchPresence = async (
  redis: Redis,
  accountId: string,
  userId: string,
  socketId: string,
  now = Date.now(),
): Promise<void> => {
  await redis.zadd(key(accountId), now + TTL_MS, `${userId}:${socketId}`);
  await redis.expire(key(accountId), TTL_MS / 1000);
};

export const removePresence = async (
  redis: Redis,
  accountId: string,
  userId: string,
  socketId: string,
): Promise<void> => {
  await redis.zrem(key(accountId), `${userId}:${socketId}`);
};

/**
 * Shared across API instances; expired leases are removed even after a process crashes.
 * SAC D6: a login-as socket (`<userId>:imp:<sessionId>:<socketId>`) makes nobody "online" for
 * ringing, unless that session has "Ring me too" on.
 */
export const onlineUsers = async (
  redis: Redis,
  accountId: string,
  now = Date.now(),
): Promise<string[]> => {
  const k = key(accountId);
  await redis.zremrangebyscore(k, '-inf', now);
  const members = await redis.zrangebyscore(k, now + 1, '+inf');
  const impersonated = members.some((m) => m.includes(':imp:'));
  const ringing = impersonated ? new Set(await ringSessionsOf(redis, accountId)) : new Set();
  const online = members.filter((member) => {
    const at = member.indexOf(':imp:');
    if (at < 0) return true;
    const sessionId = member.slice(at + 5, member.indexOf(':', at + 5));
    return ringing.has(sessionId);
  });
  return [...new Set(online.map((member) => member.slice(0, member.indexOf(':'))))];
};
