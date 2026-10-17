import { hostname } from 'node:os';

import type { Redis } from 'ioredis';

import { CAMPAIGN_LIMITS } from '../../config/limits';

/**
 * Dial slots (PHASE_8_PROMPT §1 "Slots"): one Redis sorted set per scope —
 * account, campaign (or `web:<account>` for browser test calls) and process —
 * member = call id, score = lease expiry (ms). A Lua script drops expired
 * leases and adds the member to all three sets or to none, so concurrent
 * dispatchers / API requests can never pass a limit. Leases live
 * `slotLeaseMs` and are refreshed while the call runs; a crashed process's
 * leases simply expire.
 *
 * The Lua lives here as a string (the TypeScript build does not copy `.lua` files).
 */
export const SLOTS_ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local member = ARGV[3]
local scopes = { 'account', 'group', 'process' }
for i = 1, 3 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
for i = 1, 3 do
  local limit = tonumber(ARGV[3 + i])
  if limit >= 0 and redis.call('ZSCORE', KEYS[i], member) == false then
    if redis.call('ZCARD', KEYS[i]) >= limit then return scopes[i] end
  end
end
for i = 1, 3 do
  redis.call('ZADD', KEYS[i], expiry, member)
  redis.call('PEXPIRE', KEYS[i], 3600000)
end
return 'ok'
`;

/** Token buckets (per minute) for two keys: take one token from both, or none. */
export const RATE_TAKE_LUA = `
local now = tonumber(ARGV[1])
local function level(key, cap)
  local v = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(v[1])
  local ts = tonumber(v[2])
  if tokens == nil then return cap end
  return math.min(cap, tokens + (now - ts) * cap / 60000)
end
local caps = { tonumber(ARGV[2]), tonumber(ARGV[3]) }
local tokens = { level(KEYS[1], caps[1]), level(KEYS[2], caps[2]) }
local wait = 0
for i = 1, 2 do
  if tokens[i] < 1 then
    local w = math.ceil((1 - tokens[i]) * 60000 / caps[i])
    if w > wait then wait = w end
  end
end
if wait == 0 then
  for i = 1, 2 do tokens[i] = tokens[i] - 1 end
end
for i = 1, 2 do
  redis.call('HSET', KEYS[i], 'tokens', tostring(tokens[i]), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[i], 120000)
end
return wait
`;

export type SlotScope = 'account' | 'group' | 'process';

export interface SlotLease {
  member: string;
  keys: [string, string, string];
}

export interface AcquireInput {
  accountId: string;
  /** Campaign id, or `null` for a browser test call (`web:<account>` group). */
  campaignId: string | null;
  member: string;
  limits: { account: number; group: number; process: number };
}

export type AcquireResult = { ok: true; lease: SlotLease } | { ok: false; scope: SlotScope };

type ScriptRedis = Redis & {
  cavSlotsAcquire(...args: (string | number)[]): Promise<string>;
  cavRateTake(...args: (string | number)[]): Promise<number>;
};

const withScripts = (redis: Redis): ScriptRedis => {
  const r = redis as ScriptRedis;
  if (typeof r.cavSlotsAcquire !== 'function') {
    redis.defineCommand('cavSlotsAcquire', { numberOfKeys: 3, lua: SLOTS_ACQUIRE_LUA });
    redis.defineCommand('cavRateTake', { numberOfKeys: 2, lua: RATE_TAKE_LUA });
  }
  return r;
};

export class DialSlots {
  private readonly redis: ScriptRedis;
  private readonly processKey: string;

  constructor(
    redis: Redis,
    private readonly prefix = '',
    private readonly now: () => number = Date.now,
    processId = `${hostname()}:${String(process.pid)}`,
  ) {
    this.redis = withScripts(redis);
    this.processKey = `${prefix}slots:proc:${processId}`;
  }

  private keys(accountId: string, campaignId: string | null): [string, string, string] {
    const group = campaignId ? `camp:${campaignId}` : `web:${accountId}`;
    return [
      `${this.prefix}slots:acct:${accountId}`,
      `${this.prefix}slots:${group}`,
      this.processKey,
    ];
  }

  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const keys = this.keys(input.accountId, input.campaignId);
    const now = this.now();
    const result = await this.redis.cavSlotsAcquire(
      ...keys,
      now,
      now + CAMPAIGN_LIMITS.slotLeaseMs,
      input.member,
      input.limits.account,
      input.limits.group,
      input.limits.process,
    );
    if (result === 'ok') return { ok: true, lease: { member: input.member, keys } };
    return { ok: false, scope: result as SlotScope };
  }

  /** Extends a lease (call heartbeat); a lease that already expired is not revived. */
  async refresh(lease: SlotLease): Promise<void> {
    const now = this.now();
    for (const key of lease.keys) {
      const score = await this.redis.zscore(key, lease.member);
      if (score !== null && Number(score) > now) {
        await this.redis.zadd(key, 'XX', now + CAMPAIGN_LIMITS.slotLeaseMs, lease.member);
      }
    }
  }

  async release(lease: SlotLease): Promise<void> {
    for (const key of lease.keys) await this.redis.zrem(key, lease.member);
  }

  /** Live leases of an account (all its calls). */
  async count(accountId: string): Promise<number> {
    const key = this.keys(accountId, null)[0];
    await this.redis.zremrangebyscore(key, '-inf', this.now());
    return this.redis.zcard(key);
  }
}

/** Dial-rate buckets per campaign and per account (PHASE_8_PROMPT §1 "Rate"). */
export class DialRate {
  private readonly redis: ScriptRedis;

  constructor(
    redis: Redis,
    private readonly prefix = '',
    private readonly now: () => number = Date.now,
  ) {
    this.redis = withScripts(redis);
  }

  /** Takes a dial token from both buckets: `0` = go, else ms to wait. */
  take(input: {
    accountId: string;
    campaignId: string;
    perMinute: { account: number; campaign: number };
  }): Promise<number> {
    return this.redis.cavRateTake(
      `${this.prefix}rate:acct:${input.accountId}`,
      `${this.prefix}rate:camp:${input.campaignId}`,
      this.now(),
      input.perMinute.account,
      input.perMinute.campaign,
    );
  }
}
