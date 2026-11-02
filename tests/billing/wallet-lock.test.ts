import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getEnv } from '../../src/config/env';
import { credit } from '../../src/core/billing/engine';
import {
  setWalletLockRedis,
  walletLockKey,
  withWalletLock,
} from '../../src/core/billing/wallet-lock';
import { createWallet } from '../../src/core/billing/wallets';
import { useTestDb } from '../helpers/db';

useTestDb();

let redis: Redis;
beforeAll(() => {
  redis = new Redis(getEnv().REDIS_URL ?? 'redis://127.0.0.1:6380', { db: 7 });
});
afterEach(() => {
  setWalletLockRedis(undefined);
});
afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = () => new Types.ObjectId().toString();

describe('wallet lock across processes', () => {
  it('waits while another process holds the wallet, and runs when it lets go', async () => {
    setWalletLockRedis(redis);
    const account = id();
    await redis.set(walletLockKey(account), 'other-process', 'PX', 5_000);
    let ran = false;
    const work = withWalletLock(account, () => {
      ran = true;
      return Promise.resolve('done');
    });
    await sleep(80);
    expect(ran).toBe(false);
    await redis.del(walletLockKey(account));
    await expect(work).resolves.toBe('done');
    expect(ran).toBe(true);
  });

  it('a credit waits for the other process too', async () => {
    setWalletLockRedis(redis);
    const accountId = new Types.ObjectId();
    await createWallet(accountId);
    await redis.set(walletLockKey(accountId.toString()), 'other-process', 'PX', 5_000);
    let done = false;
    const work = credit({
      accountId,
      type: 'adjustment',
      amountMicros: 1_000_000,
      ref: { type: 'manual', id: 'x' },
      idempotencyKey: `lock-${accountId.toString()}`,
    }).then(() => {
      done = true;
    });
    await sleep(80);
    expect(done).toBe(false);
    await redis.del(walletLockKey(accountId.toString()));
    await work;
    expect(done).toBe(true);
  });

  it('frees the lock after the work, also when the work fails', async () => {
    setWalletLockRedis(redis);
    const account = id();
    await withWalletLock(account, () => Promise.resolve());
    expect(await redis.get(walletLockKey(account))).toBeNull();
    await expect(withWalletLock(account, () => Promise.reject(new Error('no')))).rejects.toThrow(
      'no',
    );
    expect(await redis.get(walletLockKey(account))).toBeNull();
  });

  it("never removes another process's lock after its own has expired", async () => {
    setWalletLockRedis(redis);
    const account = id();
    await withWalletLock(account, async () => {
      await redis.set(walletLockKey(account), 'next-holder', 'PX', 5_000);
    });
    expect(await redis.get(walletLockKey(account))).toBe('next-holder');
  });

  it('goes ahead after the wait runs out: a stuck lock never blocks money', async () => {
    setWalletLockRedis(redis);
    const account = id();
    await redis.set(walletLockKey(account), 'stuck', 'PX', 5_000);
    await expect(withWalletLock(account, () => Promise.resolve('ran'), 30)).resolves.toBe('ran');
    expect(await redis.get(walletLockKey(account))).toBe('stuck');
  });

  it('goes ahead when Redis does not answer', async () => {
    setWalletLockRedis({
      set: () => new Promise(() => undefined),
      eval: () => new Promise(() => undefined),
    });
    await expect(withWalletLock(id(), () => Promise.resolve('ran'))).resolves.toBe('ran');
  });

  it('goes ahead when Redis fails, and without Redis at all', async () => {
    setWalletLockRedis({
      set: () => Promise.reject(new Error('down')),
      eval: () => Promise.reject(new Error('down')),
    });
    await expect(withWalletLock(id(), () => Promise.resolve('a'))).resolves.toBe('a');
    setWalletLockRedis(undefined);
    await expect(withWalletLock(id(), () => Promise.resolve('b'))).resolves.toBe('b');
  });
});
