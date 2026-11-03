import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isDialable, SipSpendGuard } from '../../src/core/telephony/sip/guard';
import { REDACT_PATHS } from '../../src/shared/logger';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

let redis: Redis;
const prefix = `${uniquePrefix('sip-guard')}:`;
beforeAll(async () => {
  redis = (await requireRedis()).client;
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

describe('toll-fraud guard (T18.14)', () => {
  it('dials Indian mobiles and landlines only', () => {
    const table: [string, boolean][] = [
      ['+919876543210', true],
      ['+916000000000', true],
      ['+911123456789', true], // Delhi landline
      ['+912240001234', true], // Mumbai landline
      ['+915000000000', true], // landline range
      ['+911800123456', false], // toll free
      ['+911860123456', false],
      ['+911900123456', false], // premium
      ['+911600123456', false], // 1600 caller-ID series
      ['+911401234567', false], // promotional 140
      ['+14155550100', false], // international
      ['+9198765432', false], // too short
      ['+919876543210123', false],
      ['919876543210', false],
      ['+910123456789', false],
    ];
    for (const [n, ok] of table) expect([n, isDialable(n)]).toEqual([n, ok]);
  });

  it('counts started minutes per account per hour and notices once', async () => {
    let now = Date.UTC(2026, 10, 3, 10, 0, 0);
    const guard = new SipSpendGuard(redis, prefix, () => now);
    expect(await guard.used('a1')).toBe(0);
    expect(await guard.add('a1', 61)).toBe(2);
    expect(await guard.add('a1', 1)).toBe(3);
    expect(await guard.add('a1', 0)).toBe(3);
    expect(await guard.used('a2')).toBe(0);
    expect(await guard.firstNotice('a1')).toBe(true);
    expect(await guard.firstNotice('a1')).toBe(false);
    now += 3_600_000; // next hour starts fresh
    expect(await guard.used('a1')).toBe(0);
    expect(await guard.firstNotice('a1')).toBe(true);
  });

  it('logs never carry SIP or ARI passwords', () => {
    expect(REDACT_PATHS).toEqual(expect.arrayContaining(['*.ARI_PASSWORD', '*.SIP_PASSWORD']));
  });
});
