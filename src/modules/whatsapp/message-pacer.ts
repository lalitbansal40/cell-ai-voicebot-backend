import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { campaignMps } from '../whatsapp-campaigns/pacing';

/** Redis time avoids worker clock skew; no future reservations, so downgrades take effect immediately. */
const ACQUIRE = `
local clock = redis.call('TIME')
local now = tonumber(ARGV[3]) or (tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000)
local cap = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 1000)
local count = redis.call('ZCARD', KEYS[1])
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
local delay = 0
if #last > 0 then delay = math.max(0, tonumber(last[2]) + math.ceil(1000 / cap) - now) end
if count >= cap then
  local boundary = redis.call('ZRANGE', KEYS[1], count - cap, count - cap, 'WITHSCORES')
  delay = math.max(delay, tonumber(boundary[2]) + 1000 - now)
end
if delay > 0 then return math.ceil(delay) end
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('PEXPIRE', KEYS[1], 2000)
return 0
`;

export const messagePacerKey = (accountId: string, channelId: string) =>
  `wa-pace:${accountId}:${channelId}`;

/** Returns 0 for a single granted attempt, otherwise a retry delay. Redis failure fails closed. */
export const acquireMessageSlot = async (
  redis: Pick<Redis, 'eval'>,
  channel: {
    _id: { toString(): string };
    accountId: { toString(): string };
    mode?: string;
    isOnBizApp?: boolean;
    messageClassificationKnown?: boolean;
  },
  ceiling?: number,
  /** Deterministic clock for isolated limiter tests only; production uses Redis TIME. */
  testNowMs?: number,
): Promise<number> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      redis.eval(
        ACQUIRE,
        1,
        messagePacerKey(channel.accountId.toString(), channel._id.toString()),
        campaignMps(channel, ceiling),
        randomUUID(),
        testNowMs ?? '',
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('pacer timeout')), 500);
      }),
    ]);
    return typeof result === 'number' && result >= 0 ? result : 1000;
  } catch {
    return 1000;
  } finally {
    clearTimeout(timer);
  }
};
