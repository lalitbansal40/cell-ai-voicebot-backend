import type { Redis } from 'ioredis';

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

/** Shared across API instances; expired leases are removed even after a process crashes. */
export const onlineUsers = async (
  redis: Redis,
  accountId: string,
  now = Date.now(),
): Promise<string[]> => {
  const k = key(accountId);
  await redis.zremrangebyscore(k, '-inf', now);
  const members = await redis.zrangebyscore(k, now + 1, '+inf');
  return [...new Set(members.map((member) => member.slice(0, member.indexOf(':'))))];
};
