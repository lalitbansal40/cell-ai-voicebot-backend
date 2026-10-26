import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

import { REPORT_LIMITS } from '../../config/limits';
import { getLogger } from '../../shared/logger';

export type ReportCacheStore = Pick<Redis, 'get' | 'set'>;

export const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** `reports:<accountId>:<tab>:<sha1 of the resolved filters>` */
export const reportCacheKey = (accountId: string, tab: string, filters: unknown): string =>
  `reports:${accountId}:${tab}:${sha1(JSON.stringify(filters))}`;

const TIMEOUT_MS = 300;

/** Redis waits forever while it is down (`maxRetriesPerRequest: null`) — never let a report wait. */
const within = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error('report cache timeout'));
      }, TIMEOUT_MS).unref();
    }),
  ]);

/**
 * Cached JSON body (60 s). Redis trouble never breaks a report: it is built again.
 */
export const cachedReport = async (
  store: ReportCacheStore | null,
  key: string,
  build: () => Promise<unknown>,
): Promise<string> => {
  if (store) {
    try {
      const hit = await within(store.get(key));
      if (hit) return hit;
    } catch (err) {
      getLogger().warn({ err }, 'reports: cache read failed');
    }
  }
  const body = JSON.stringify(await build());
  if (store) {
    try {
      await within(store.set(key, body, 'EX', REPORT_LIMITS.cacheTtlSec));
    } catch (err) {
      getLogger().warn({ err }, 'reports: cache write failed');
    }
  }
  return body;
};
