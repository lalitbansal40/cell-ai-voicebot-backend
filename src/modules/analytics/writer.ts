import type { AnyBulkWriteOperation, Types } from 'mongoose';

import {
  AnalyticsMarkModel,
  analyticsMarkId,
  type AnalyticsEntity,
  type AnalyticsMarkDoc,
  type AnalyticsRow,
} from '../../db/models/analytics-mark.model';
import { StatsDailyModel, type StatsDailyDoc } from '../../db/models/stats-daily.model';
import { withTransaction } from '../../db/transaction';

import type { EntityRows } from './context';
import { diffRows, mergeRows } from './definitions';

const statsFilter = (accountId: Types.ObjectId, r: AnalyticsRow) => ({
  accountId,
  day: r.day,
  channel: r.channel,
  test: r.test,
  kind: r.kind,
  refId: r.refId,
});

/** `$inc` upserts for rows (counters may be negative: a correction). */
export const statsIncrements = (
  accountId: Types.ObjectId,
  rows: AnalyticsRow[],
): AnyBulkWriteOperation<StatsDailyDoc>[] =>
  rows.map((r) => ({
    updateOne: {
      filter: statsFilter(accountId, r),
      update: {
        $inc: Object.fromEntries(Object.entries(r.counters).map(([k, v]) => [`counters.${k}`, v])),
      },
      upsert: true,
    },
  }));

/**
 * Applies each entity's change since it was last counted: rollups get `next − counted`,
 * the mark becomes `next`. One transaction per batch, so a crash never leaves the
 * rollups and the marks out of step. Idempotent: the same rows twice change nothing.
 */
export const applyEntityRows = async (
  entity: AnalyticsEntity,
  items: EntityRows[],
): Promise<{ changed: number }> => {
  if (!items.length) return { changed: 0 };
  const marks = await AnalyticsMarkModel.find({
    _id: { $in: items.map((i) => analyticsMarkId(entity, i.id)) },
  }).lean<AnalyticsMarkDoc[]>();
  const byId = new Map(marks.map((m) => [m._id, m]));
  const stats: AnyBulkWriteOperation<StatsDailyDoc>[] = [];
  const markOps: AnyBulkWriteOperation<AnalyticsMarkDoc>[] = [];
  for (const item of items) {
    const id = analyticsMarkId(entity, item.id);
    const counted = byId.get(id)?.rows ?? [];
    const diff = diffRows(counted, item.rows);
    if (!diff.length) continue;
    stats.push(...statsIncrements(item.accountId, diff));
    markOps.push({
      updateOne: {
        filter: { _id: id },
        update: { $set: { accountId: item.accountId, entity, rows: mergeRows(item.rows) } },
        upsert: true,
      },
    });
  }
  if (!markOps.length) return { changed: 0 };
  await withTransaction(async (session) => {
    await StatsDailyModel.bulkWrite(stats, { session, ordered: false });
    await AnalyticsMarkModel.bulkWrite(markOps, { session, ordered: false });
  });
  return { changed: markOps.length };
};
