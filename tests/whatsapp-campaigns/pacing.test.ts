import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { acquireMessageSlot } from '../../src/modules/whatsapp/message-pacer';
import { campaignMps } from '../../src/modules/whatsapp-campaigns/pacing';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

const prefix = uniquePrefix('pacer');
let redis: Redis;
let other: Redis;
let n = 0;
const channel = (mode = 'cloud_api', isOnBizApp = false) => ({
  _id: `${++n}`,
  accountId: prefix,
  mode,
  isOnBizApp,
  messageClassificationKnown: true,
});
beforeAll(async () => {
  redis = (await requireRedis()).client;
  other = redis.duplicate();
  await other.ping();
});
afterAll(async () => {
  await flushPrefix(redis, `wa-pace:${prefix}:`);
  other.disconnect();
  redis.disconnect();
});

describe('per-number shared message pacing', () => {
  it('derives 18/75 from channel facts and only allows lower env ceilings', () => {
    expect(campaignMps(channel())).toBe(75);
    expect(campaignMps(channel('coexistence'))).toBe(18);
    expect(campaignMps(channel('cloud_api', true))).toBe(18);
    expect(campaignMps()).toBe(18);
    expect(campaignMps({ mode: 'cloud_api', isOnBizApp: false })).toBe(18);
    expect(campaignMps({ mode: 'cloud_api' })).toBe(18);
    expect(campaignMps(channel(), 80)).toBe(75);
    expect(campaignMps(channel('coexistence'), 75)).toBe(18);
    expect(campaignMps(channel(), 5)).toBe(5);
    expect(campaignMps(channel(), Number.NaN)).toBe(75);
  });
  it.each([
    ['coexistence', false, 18],
    ['cloud_api', true, 18],
    ['cloud_api', false, 75],
  ] as const)('never exceeds rolling cap for %s / app %s', async (mode, app, cap) => {
    const c = channel(mode, app);
    const attempts: number[] = [];
    let time = 10_000;
    for (let i = 0; i < 1000; i++) {
      const worker = i % 2 ? other : redis;
      let delay = await acquireMessageSlot(worker, c, undefined, time);
      while (delay) {
        time += delay;
        delay = await acquireMessageSlot(worker, c, undefined, time);
      }
      attempts.push(time);
      expect(attempts.filter((at) => at > time - 1000).length).toBeLessThanOrEqual(cap);
    }
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(Math.ceil(1000 / cap));
  });
  it('atomically grants only one simultaneous attempt and isolates different numbers', async () => {
    const c = channel();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        acquireMessageSlot(i % 2 ? redis : other, c, undefined, 10_000),
      ),
    );
    expect(results.filter((ms) => ms === 0)).toHaveLength(1);
    expect(await acquireMessageSlot(other, channel(), undefined, 10_000)).toBe(0);
  });
  it('persists across workers/restarts, consumes retries, and respects a live downgrade', async () => {
    const c = channel();
    for (let i = 0; i < 40; i++)
      expect(await acquireMessageSlot(redis, c, undefined, 10_000 + i * 14)).toBe(0);
    expect(await acquireMessageSlot(other, c, undefined, 10_546)).toBeGreaterThan(0);
    expect(
      await acquireMessageSlot(other, { ...c, isOnBizApp: true }, undefined, 10_600),
    ).toBeGreaterThan(400);
    expect(await acquireMessageSlot(other, { ...c, isOnBizApp: true }, undefined, 11_600)).toBe(0);
  });
  it('uses Redis time and expires idle keys', async () => {
    const c = channel();
    expect(await acquireMessageSlot(redis, c)).toBe(0);
    expect(await redis.pttl(`wa-pace:${prefix}:${c._id}`)).toBeGreaterThan(0);
    expect(await acquireMessageSlot(other, c, 1)).toBeGreaterThan(0);
  });
  it('defers on Redis failure or malformed output rather than sending without a limit', async () => {
    expect(
      await acquireMessageSlot(
        { eval: vi.fn().mockRejectedValue(new Error('offline')) },
        channel(),
      ),
    ).toBe(1000);
    expect(await acquireMessageSlot({ eval: vi.fn().mockResolvedValue(null) }, channel())).toBe(
      1000,
    );
  });
});
