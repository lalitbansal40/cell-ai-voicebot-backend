import { randomBytes } from 'node:crypto';

import { getLogger } from '../../shared/logger';

/**
 * Keeps one wallet's transactions in order across processes (ADR 0049: API and worker are
 * separate). Run in parallel they conflict and the driver retries with no pause. Correctness never
 * depends on this lock: the transaction still decides, so with Redis down, or after the wait, the
 * work simply goes ahead.
 */
export interface LockRedis {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, keys: number, key: string, value: string): Promise<unknown>;
}

const LOCK_TTL_MS = 5_000;
const MAX_WAIT_MS = 10_000;
/** `maxRetriesPerRequest: null` makes a command wait forever while Redis is down. */
const COMMAND_TIMEOUT_MS = 500;
const RETRY_MIN_MS = 10;
const RETRY_SPREAD_MS = 30;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

let redis: LockRedis | undefined;

/** Set at start-up where Redis exists; without it (tests, one-off scripts) nothing is locked. */
export const setWalletLockRedis = (client: LockRedis | undefined): void => {
  redis = client;
};

export const walletLockKey = (accountId: string): string => `wallet:lock:${accountId}`;

const within = async <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('redis timeout')), COMMAND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `fn` holding the wallet's lock when it can be had; `fn` always runs exactly once. */
export const withWalletLock = async <T>(
  accountId: string,
  fn: () => Promise<T>,
  maxWaitMs = MAX_WAIT_MS,
): Promise<T> => {
  const client = redis;
  if (!client) return fn();
  const key = walletLockKey(accountId);
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + maxWaitMs;
  let held = false;
  try {
    for (;;) {
      held = (await within(client.set(key, token, 'PX', LOCK_TTL_MS, 'NX'))) === 'OK';
      if (held || Date.now() >= deadline) break;
      await sleep(RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS);
    }
  } catch (err) {
    getLogger().warn({ errName: (err as Error).name }, 'wallet lock: redis unavailable');
  }
  try {
    return await fn();
  } finally {
    if (held) {
      await within(client.eval(RELEASE, 1, key, token)).catch(() => undefined);
    }
  }
};
