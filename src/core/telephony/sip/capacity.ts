import type { Redis } from 'ioredis';

/**
 * Trunk limits shared by every process (ADR 0050): channels in use (a sorted set of
 * leases that expire unless refreshed, so a crashed process frees its channels) and
 * new calls per second (a counter per second). A transfer takes its own channel.
 */

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

const CPS = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], 2000) end
return n
`;

export interface SipCapacityOptions {
  redis: Redis;
  prefix?: string;
  maxChannels: number;
  maxCps: number;
  /** A lease lives this long without a refresh (the owner refreshes every third of it). */
  leaseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SipCapacity {
  private readonly channelsKey: string;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SipCapacityOptions) {
    const prefix = options.prefix ?? '';
    this.channelsKey = `${prefix}sip:channels`;
    this.leaseMs = options.leaseMs ?? 90_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get refreshEveryMs(): number {
    return Math.floor(this.leaseMs / 3);
  }

  /** A channel for `id` (call id, or `<callId>:xfer`); false when the trunk is full. */
  async acquire(id: string): Promise<boolean> {
    const now = this.now();
    const got = await this.options.redis.eval(
      ACQUIRE,
      1,
      this.channelsKey,
      String(now),
      String(now + this.leaseMs),
      id,
      String(this.options.maxChannels),
      String(this.leaseMs * 4),
    );
    return got === 1;
  }

  async release(id: string): Promise<void> {
    await this.options.redis.zrem(this.channelsKey, id);
  }

  /** Keeps this process's leases alive. */
  async refresh(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const until = this.now() + this.leaseMs;
    await this.options.redis.zadd(this.channelsKey, 'XX', ...ids.flatMap((id) => [until, id]));
  }

  async inUse(): Promise<number> {
    await this.options.redis.zremrangebyscore(this.channelsKey, '-inf', this.now());
    return this.options.redis.zcard(this.channelsKey);
  }

  /** Waits for a calls-per-second slot (at most `maxWaitMs`); false when none came. */
  async dialToken(maxWaitMs = 3000): Promise<boolean> {
    const end = this.now() + maxWaitMs;
    for (;;) {
      const now = this.now();
      const second = Math.floor(now / 1000);
      const n = await this.options.redis.eval(
        CPS,
        1,
        `${this.options.prefix ?? ''}sip:cps:${String(second)}`,
      );
      if (Number(n) <= this.options.maxCps) return true;
      const wait = (second + 1) * 1000 - now;
      if (now + wait > end) return false;
      await this.sleep(wait);
    }
  }
}
