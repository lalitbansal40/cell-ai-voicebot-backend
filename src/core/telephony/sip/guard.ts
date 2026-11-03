import type { Redis } from 'ioredis';

import { SIP_LIMITS } from '../../../config/limits';

/** Toll-fraud guard (T18.14): only Indian mobiles and landlines; no short, toll-free or premium codes. */
export const isDialable = (e164: string): boolean => {
  if (SIP_LIMITS.mobile.test(e164)) return true;
  if (!SIP_LIMITS.landline.test(e164)) return false;
  return !SIP_LIMITS.blockedPrefixes.some((p) => e164.startsWith(p));
};

/**
 * SIP minutes per account per clock hour (Redis counter, kept 2 h). A call's started
 * minutes are added when it ends; dials stop while the hour is over the limit.
 */
export class SipSpendGuard {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = '',
    private readonly now: () => number = Date.now,
  ) {}

  private key(accountId: string): string {
    return `${this.prefix}sip:spend:${accountId}:${String(Math.floor(this.now() / 3_600_000))}`;
  }

  async add(accountId: string, durationSec: number): Promise<number> {
    const minutes = Math.ceil(Math.max(0, durationSec) / 60);
    const key = this.key(accountId);
    const total = await this.redis.incrby(key, minutes);
    await this.redis.pexpire(key, 7_200_000);
    return total;
  }

  async used(accountId: string): Promise<number> {
    return Number((await this.redis.get(this.key(accountId))) ?? 0);
  }

  /** True the first time this hour (one notice per account per hour). */
  async firstNotice(accountId: string): Promise<boolean> {
    const set = await this.redis.set(`${this.key(accountId)}:notice`, '1', 'PX', 7_200_000, 'NX');
    return set === 'OK';
  }
}
