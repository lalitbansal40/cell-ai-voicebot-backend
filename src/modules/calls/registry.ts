import { hostname } from 'node:os';

import type { Redis } from 'ioredis';

import { CALL_LIMITS } from '../../config/limits';

export interface LiveCall {
  accountId: string;
  pid: number;
  host: string;
  startedAt: number;
  heartbeatAt: number;
}

/**
 * Live calls in Redis: `call:live:<callId>` (TTL, refreshed by the owning
 * process) + a set per account for the concurrency limit (stale members are
 * dropped on read).
 */
export class CallRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = '',
  ) {}

  private key(callId: string): string {
    return `${this.prefix}call:live:${callId}`;
  }

  private accountKey(accountId: string): string {
    return `${this.prefix}call:live:acct:${accountId}`;
  }

  async register(callId: string, accountId: string, now: number, ttlSec: number): Promise<void> {
    const value: LiveCall = {
      accountId,
      pid: process.pid,
      host: hostname(),
      startedAt: now,
      heartbeatAt: now,
    };
    await this.redis.set(this.key(callId), JSON.stringify(value), 'EX', ttlSec);
    await this.redis.sadd(this.accountKey(accountId), callId);
    await this.redis.expire(this.accountKey(accountId), CALL_LIMITS.maxCallSecHard * 2);
  }

  async heartbeat(
    callId: string,
    accountId: string,
    startedAt: number,
    now: number,
  ): Promise<void> {
    const value: LiveCall = {
      accountId,
      pid: process.pid,
      host: hostname(),
      startedAt,
      heartbeatAt: now,
    };
    await this.redis.set(this.key(callId), JSON.stringify(value), 'EX', CALL_LIMITS.registryTtlSec);
  }

  async unregister(callId: string, accountId: string): Promise<void> {
    await this.redis.del(this.key(callId));
    await this.redis.srem(this.accountKey(accountId), callId);
  }

  async isLive(callId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(callId))) === 1;
  }

  /** Live calls of an account (stale set members are removed). */
  async liveCalls(accountId: string): Promise<string[]> {
    const members = await this.redis.smembers(this.accountKey(accountId));
    const live: string[] = [];
    for (const callId of members) {
      if (await this.isLive(callId)) live.push(callId);
      else await this.redis.srem(this.accountKey(accountId), callId);
    }
    return live;
  }
}
