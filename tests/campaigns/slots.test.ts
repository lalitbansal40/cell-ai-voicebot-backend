import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CAMPAIGN_LIMITS } from '../../src/config/limits';
import { DialRate, DialSlots } from '../../src/modules/campaigns/slots';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

const prefix = `${uniquePrefix('slots')}:`;
let redis: Redis;
let now = 1_000_000;
const clock = () => now;

beforeAll(async () => {
  redis = (await requireRedis()).client;
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

const limits = (account: number, group: number, processLimit: number) => ({
  account,
  group,
  process: processLimit,
});

describe('DialSlots', () => {
  it('each scope has its own limit; the refused scope is named; re-acquire is idempotent', async () => {
    const slots = new DialSlots(redis, `${prefix}a:`, clock, 'p1');
    const take = (member: string, campaignId: string | null, l = limits(3, 2, 10)) =>
      slots.acquire({ accountId: 'acc1', campaignId, member, limits: l });
    expect((await take('c1', 'camp1')).ok).toBe(true);
    expect((await take('c2', 'camp1')).ok).toBe(true);
    expect(await take('c3', 'camp1')).toEqual({ ok: false, scope: 'group' });
    // the same call again does not take a second slot
    expect((await take('c2', 'camp1')).ok).toBe(true);
    expect((await take('c4', 'camp2')).ok).toBe(true);
    expect(await take('c5', 'camp2')).toEqual({ ok: false, scope: 'account' });
    expect(await slots.count('acc1')).toBe(3);
    // web test calls: their own group, -1 = unlimited
    expect(await take('w1', null, limits(10, 1, 10))).toMatchObject({ ok: true });
    expect(await take('w2', null, limits(10, 1, 10))).toEqual({ ok: false, scope: 'group' });
    expect((await take('w3', null, limits(10, -1, 10))).ok).toBe(true);
    // process limit
    const other = new DialSlots(redis, `${prefix}a:`, clock, 'p2');
    expect(
      await other.acquire({
        accountId: 'acc2',
        campaignId: 'x',
        member: 'z1',
        limits: limits(5, 5, 0),
      }),
    ).toEqual({ ok: false, scope: 'process' });
  });

  it('leases expire unless refreshed; release frees at once; refresh does not revive', async () => {
    const slots = new DialSlots(redis, `${prefix}b:`, clock, 'p1');
    const r1 = await slots.acquire({
      accountId: 'a',
      campaignId: 'k',
      member: 'm1',
      limits: limits(1, 1, 1),
    });
    if (!r1.ok) throw new Error('no slot');
    now += CAMPAIGN_LIMITS.slotLeaseMs - 1;
    await slots.refresh(r1.lease);
    now += CAMPAIGN_LIMITS.slotLeaseMs - 1;
    expect(await slots.count('a')).toBe(1);
    expect(
      (
        await slots.acquire({
          accountId: 'a',
          campaignId: 'k',
          member: 'm2',
          limits: limits(1, 1, 1),
        })
      ).ok,
    ).toBe(false);
    now += 2;
    expect(await slots.count('a')).toBe(0);
    await slots.refresh(r1.lease); // expired lease: XX update of a removed member is a no-op
    expect(await slots.count('a')).toBe(0);
    const r2 = await slots.acquire({
      accountId: 'a',
      campaignId: 'k',
      member: 'm2',
      limits: limits(1, 1, 1),
    });
    if (!r2.ok) throw new Error('no slot');
    await slots.release(r2.lease);
    expect(await slots.count('a')).toBe(0);
  });

  it('50 parallel acquires never pass any limit', async () => {
    const a = new DialSlots(redis, `${prefix}c:`, clock, 'p1');
    const b = new DialSlots(redis, `${prefix}c:`, clock, 'p2');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 ? a : b).acquire({
          accountId: 'acc',
          campaignId: i % 3 ? 'one' : 'two',
          member: `call-${String(i)}`,
          limits: limits(7, 4, 5),
        }),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    expect(ok).toBeLessThanOrEqual(7);
    expect(ok).toBeGreaterThan(0);
    expect(await a.count('acc')).toBe(ok);
    expect(await redis.zcard(`${prefix}c:slots:camp:one`)).toBeLessThanOrEqual(4);
    expect(await redis.zcard(`${prefix}c:slots:proc:p1`)).toBeLessThanOrEqual(5);
  });
});

describe('DialRate', () => {
  it('per-minute buckets on both keys: start full, refill linearly, report the wait', async () => {
    let t = 5_000_000;
    const rate = new DialRate(redis, `${prefix}r:`, () => t);
    const take = () =>
      rate.take({ accountId: 'acc', campaignId: 'camp', perMinute: { account: 60, campaign: 2 } });
    expect(await take()).toBe(0);
    expect(await take()).toBe(0);
    // campaign bucket (2 / min) is empty: one token every 30 s
    expect(await take()).toBe(30_000);
    t += 15_000;
    expect(await take()).toBe(15_000);
    t += 15_000;
    expect(await take()).toBe(0);
    // the account bucket was charged for the 3 successful takes only
    const other = () =>
      rate.take({
        accountId: 'acc',
        campaignId: 'camp2',
        perMinute: { account: 60, campaign: 60 },
      });
    expect(await other()).toBe(0);
    const tight = new DialRate(redis, `${prefix}r2:`, () => t);
    const once = () =>
      tight.take({ accountId: 'x', campaignId: 'y', perMinute: { account: 1, campaign: 60 } });
    expect(await once()).toBe(0);
    expect(await once()).toBe(60_000);
  });
});
