import type { Types } from 'mongoose';

import { rebuildAccount } from '../../modules/analytics/rebuild';
import { ymdInZone } from '../../shared/time';
import type { Migration } from '../migrate';
import { AccountModel } from '../models/account.model';
import { AnalyticsMarkModel } from '../models/analytics-mark.model';
import { CallModel } from '../models/call.model';
import { LedgerEntryModel } from '../models/ledger-entry.model';
import { MessageModel } from '../models/message.model';
import { StatsDailyModel } from '../models/stats-daily.model';

export const ANALYTICS_SWEEP_INDEX = 'analytics_sweep';
export const ANALYTICS_REBUILD_INDEX = 'analytics_rebuild';

const earliest = async (accountId: Types.ObjectId): Promise<Date | null> => {
  const firsts = await Promise.all([
    CallModel.findOne({ accountId }).sort({ createdAt: 1 }).select({ createdAt: 1 }).lean(),
    MessageModel.findOne({ accountId }).sort({ at: 1 }).select({ at: 1 }).lean(),
    LedgerEntryModel.findOne({ accountId }).sort({ createdAt: 1 }).select({ createdAt: 1 }).lean(),
  ]);
  const dates = [firsts[0]?.createdAt, firsts[1]?.at, firsts[2]?.createdAt].filter(
    (d): d is Date => d instanceof Date,
  );
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
};

/**
 * Phase 14: report rollups (`statsDaily`) + per-entity marks (`analyticsMarks`), the sweep
 * indexes on calls / messages / ledger rows, and a backfill of every account from its
 * first call / message / ledger row to today (resumable: a rerun recounts the same days).
 */
export const analyticsMigration: Migration = {
  name: '0015-analytics',
  up: async () => {
    await StatsDailyModel.createIndexes();
    await AnalyticsMarkModel.createIndexes();
    await CallModel.createIndexes();
    await MessageModel.createIndexes();
    await LedgerEntryModel.createIndexes();
    const accounts = await AccountModel.find({})
      .select({ timezone: 1 })
      .lean<{ _id: Types.ObjectId; timezone?: string }[]>();
    const now = new Date();
    for (const a of accounts) {
      const first = await earliest(a._id);
      if (!first) continue;
      const tz = a.timezone ?? 'Asia/Kolkata';
      await rebuildAccount({
        accountId: a._id,
        from: ymdInZone(first, tz),
        to: ymdInZone(now, tz),
      });
    }
  },
  down: async (db) => {
    for (const name of ['statsDaily', 'analyticsMarks'])
      if ((await db.listCollections({ name }).toArray()).length) await db.dropCollection(name);
    for (const [collection, index] of [
      ['calls', ANALYTICS_SWEEP_INDEX],
      ['messages', ANALYTICS_SWEEP_INDEX],
      ['messages', ANALYTICS_REBUILD_INDEX],
      ['ledgerEntries', ANALYTICS_SWEEP_INDEX],
    ] as const) {
      const c = db.collection(collection);
      if (await c.indexExists(index)) await c.dropIndex(index);
    }
  },
};
