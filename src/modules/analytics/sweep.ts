/**
 * `analytics-sweep` (every minute): counts every call, WhatsApp message and ledger row
 * that changed since the last sweep (`updatedAt` watermark per collection, re-reading
 * `sweepOverlapSec` for late commits). Catching changes by `updatedAt` covers every
 * write path — late Meta durations, status webhooks, manual dispositions — without a
 * hook in each service (ADR 0043). Idempotent; one writer at a time (Redis lock).
 */
import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';
import type { Model, Types } from 'mongoose';

import { REPORT_LIMITS } from '../../config/limits';
import type { AnalyticsEntity } from '../../db/models/analytics-mark.model';
import { CallModel } from '../../db/models/call.model';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';

import {
  CALL_FIELDS,
  LEDGER_FIELDS,
  MESSAGE_FIELDS,
  callBatchRows,
  ledgerBatchRows,
  messageBatchRows,
  type CallRow,
  type EntityRows,
  type LedgerRow,
  type MessageRow,
} from './context';
import { applyEntityRows } from './writer';

export type AnalyticsRedis = Pick<Redis, 'get' | 'set' | 'eval'>;

export interface AnalyticsDeps {
  redis: AnalyticsRedis;
  /** Key prefix (tests use a unique one). */
  prefix?: string;
  now?: () => Date;
}

const key = (deps: AnalyticsDeps, name: string) => `${deps.prefix ?? ''}analytics-${name}`;

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Runs `fn` while holding the analytics writer lock; `null` when someone else holds it. */
export const withAnalyticsLock = async <T>(
  deps: AnalyticsDeps,
  fn: () => Promise<T>,
): Promise<T | null> => {
  const token = randomBytes(8).toString('hex');
  const lock = key(deps, 'lock');
  const ok = await deps.redis.set(lock, token, 'EX', REPORT_LIMITS.lockTtlSec, 'NX');
  if (ok !== 'OK') return null;
  try {
    return await fn();
  } finally {
    await deps.redis.eval(RELEASE, 1, lock, token);
  }
};

interface Source<T extends { _id: Types.ObjectId; updatedAt: Date }> {
  model: Model<never>;
  fields: Record<string, 1>;
  rows: (docs: T[]) => Promise<EntityRows[]>;
}

const SOURCES: { [K in AnalyticsEntity]: Source<{ _id: Types.ObjectId; updatedAt: Date }> } = {
  call: {
    model: CallModel as unknown as Model<never>,
    fields: CALL_FIELDS,
    rows: (docs) => callBatchRows(docs as CallRow[]),
  },
  message: {
    model: MessageModel as unknown as Model<never>,
    fields: MESSAGE_FIELDS,
    rows: (docs) => messageBatchRows(docs as MessageRow[]),
  },
  ledger: {
    model: LedgerEntryModel as unknown as Model<never>,
    fields: LEDGER_FIELDS,
    rows: (docs) => ledgerBatchRows(docs as LedgerRow[]),
  },
};

export const ANALYTICS_ENTITY_ORDER: readonly AnalyticsEntity[] = ['call', 'message', 'ledger'];

const sweepEntity = async (
  deps: AnalyticsDeps,
  entity: AnalyticsEntity,
  now: Date,
): Promise<{ seen: number; changed: number }> => {
  const source = SOURCES[entity];
  const wmKey = key(deps, `wm-${entity}`);
  const stored = await deps.redis.get(wmKey);
  const start = stored
    ? new Date(new Date(stored).getTime() - REPORT_LIMITS.sweepOverlapSec * 1000)
    : new Date(now.getTime() - REPORT_LIMITS.reconcileDays * 86_400_000);
  let cursor: { at: Date; id: Types.ObjectId } | null = null;
  let newest: Date | null = stored ? new Date(stored) : null;
  let seen = 0;
  let changed = 0;
  for (;;) {
    const filter: Record<string, unknown> = cursor
      ? {
          $or: [
            { updatedAt: { $gt: cursor.at } },
            { updatedAt: cursor.at, _id: { $gt: cursor.id } },
          ],
        }
      : { updatedAt: { $gte: start } };
    const docs = await source.model
      .find(filter as never)
      .sort({ updatedAt: 1, _id: 1 })
      .limit(REPORT_LIMITS.sweepBatch)
      .select(source.fields)
      .lean<{ _id: Types.ObjectId; updatedAt: Date }[]>();
    if (!docs.length) break;
    const result = await applyEntityRows(entity, await source.rows(docs));
    seen += docs.length;
    changed += result.changed;
    const last = docs[docs.length - 1] as { _id: Types.ObjectId; updatedAt: Date };
    cursor = { at: last.updatedAt, id: last._id };
    if (!newest || last.updatedAt > newest) newest = last.updatedAt;
    if (docs.length < REPORT_LIMITS.sweepBatch) break;
  }
  if (newest) await deps.redis.set(wmKey, newest.toISOString());
  return { seen, changed };
};

export const sweepAnalytics = async (deps: AnalyticsDeps): Promise<Record<string, number>> => {
  const now = deps.now?.() ?? new Date();
  const result = await withAnalyticsLock(deps, async () => {
    const out: Record<string, number> = {};
    for (const entity of ANALYTICS_ENTITY_ORDER) {
      const r = await sweepEntity(deps, entity, now);
      out[`${entity}Seen`] = r.seen;
      out[`${entity}Changed`] = r.changed;
    }
    return out;
  });
  return result ?? { skipped: 1 };
};
