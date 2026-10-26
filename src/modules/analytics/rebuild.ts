/**
 * Recount from raw rows (`analytics:rebuild`, the nightly reconcile, migration 0015):
 * recomputes an account's rollups for a day range with the same definitions the sweep
 * uses, compares them with `statsDaily` and (unless dry-run) replaces those days and
 * resets the marks of every recounted row. Days older than the raw-data retention are
 * never rebuilt — their raw rows are gone and their rollups are the only record.
 */
import type { AnyBulkWriteOperation, Model, Types } from 'mongoose';

import { REPORT_LIMITS } from '../../config/limits';
import { AccountModel } from '../../db/models/account.model';
import {
  AnalyticsMarkModel,
  analyticsMarkId,
  type AnalyticsEntity,
  type AnalyticsMarkDoc,
  type AnalyticsRow,
} from '../../db/models/analytics-mark.model';
import { CallModel } from '../../db/models/call.model';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';
import { StatsDailyModel, type StatsDailyDoc } from '../../db/models/stats-daily.model';
import { addDays, startOfDayInZone, ymdInZone } from '../../shared/time';

import {
  CALL_FIELDS,
  LEDGER_FIELDS,
  MESSAGE_FIELDS,
  callBatchRows,
  ledgerBatchRows,
  messageBatchRows,
  type EntityRows,
} from './context';
import { mergeRows, rowKey } from './definitions';

const BATCH = 500;

export interface RebuildInput {
  accountId: Types.ObjectId;
  /** Account-local days, inclusive. */
  from: string;
  to: string;
  dryRun?: boolean;
  /** Oldest day whose raw rows are complete (older days are skipped). */
  floor?: string;
}

export interface RebuildResult {
  from: string;
  to: string;
  /** Rollup rows the recount produced. */
  rows: number;
  /** Rows whose counters differ from what `statsDaily` holds (0 = in step). */
  differences: number;
  written: boolean;
}

interface Scan {
  entity: AnalyticsEntity;
  model: Model<never>;
  /** The field that decides the day (index-backed with `accountId`). */
  timeField: 'createdAt' | 'at';
  fields: Record<string, 1>;
  rows: (docs: never[]) => Promise<EntityRows[]>;
}

const SCANS: Scan[] = [
  {
    entity: 'call',
    model: CallModel as unknown as Model<never>,
    timeField: 'createdAt',
    fields: CALL_FIELDS,
    rows: (docs) => callBatchRows(docs),
  },
  {
    entity: 'message',
    model: MessageModel as unknown as Model<never>,
    timeField: 'at',
    fields: MESSAGE_FIELDS,
    rows: (docs) => messageBatchRows(docs),
  },
  {
    entity: 'ledger',
    model: LedgerEntryModel as unknown as Model<never>,
    timeField: 'createdAt',
    fields: LEDGER_FIELDS,
    rows: (docs) => ledgerBatchRows(docs),
  },
];

/** The first day whose raw calls and messages are still complete. */
export const rawFloor = (
  now: Date,
  timeZone: string,
  retention: { callsDays: number; inboxDays: number },
): string => {
  const days = Math.min(
    retention.callsDays,
    retention.inboxDays > 0 ? retention.inboxDays : Infinity,
  );
  return addDays(ymdInZone(now, timeZone), -days + 1);
};

const sameCounters = (a: Record<string, number> = {}, b: Record<string, number> = {}): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

export const rebuildAccount = async (input: RebuildInput): Promise<RebuildResult> => {
  const account = await AccountModel.findById(input.accountId)
    .select({ timezone: 1 })
    .lean<{ timezone?: string }>();
  const timeZone = account?.timezone ?? 'Asia/Kolkata';
  const from = input.floor && input.floor > input.from ? input.floor : input.from;
  const to = input.to;
  if (from > to) return { from, to, rows: 0, differences: 0, written: false };
  const start = startOfDayInZone(addDays(from, -REPORT_LIMITS.rebuildMarginDays), timeZone);
  const end = startOfDayInZone(addDays(to, 1 + REPORT_LIMITS.rebuildMarginDays), timeZone);
  const inRange = (r: AnalyticsRow) => r.day >= from && r.day <= to;

  const computed = new Map<string, AnalyticsRow>();
  const add = (r: AnalyticsRow) => {
    const k = rowKey(r);
    const into = computed.get(k) ?? { ...r, counters: {} };
    for (const [c, v] of Object.entries(r.counters)) into.counters[c] = (into.counters[c] ?? 0) + v;
    computed.set(k, into);
  };
  for (const scan of SCANS) {
    const t = scan.timeField;
    let cursor: { at: Date; id: Types.ObjectId } | null = null;
    for (;;) {
      const docs: ({ _id: Types.ObjectId } & Record<string, unknown>)[] = await scan.model
        .find({
          accountId: input.accountId,
          [t]: { $gte: start, $lt: end },
          ...(cursor
            ? { $or: [{ [t]: { $gt: cursor.at } }, { [t]: cursor.at, _id: { $gt: cursor.id } }] }
            : {}),
        } as never)
        .sort({ [t]: 1, _id: 1 })
        .limit(BATCH)
        .select({ ...scan.fields, [t]: 1 })
        .lean<({ _id: Types.ObjectId } & Record<string, unknown>)[]>();
      if (!docs.length) break;
      const marks: AnyBulkWriteOperation<AnalyticsMarkDoc>[] = [];
      for (const item of await scan.rows(docs as never[])) {
        for (const r of item.rows) if (inRange(r)) add(r);
        const merged = mergeRows(item.rows);
        marks.push(
          merged.length
            ? {
                updateOne: {
                  filter: { _id: analyticsMarkId(scan.entity, item.id) },
                  update: {
                    $set: { accountId: input.accountId, entity: scan.entity, rows: merged },
                  },
                  upsert: true,
                },
              }
            : { deleteOne: { filter: { _id: analyticsMarkId(scan.entity, item.id) } } },
        );
      }
      if (!input.dryRun) await AnalyticsMarkModel.bulkWrite(marks, { ordered: false });
      const last = docs[docs.length - 1] as { _id: Types.ObjectId } & Record<string, unknown>;
      cursor = { at: last[t] as Date, id: last._id };
      if (docs.length < BATCH) break;
    }
  }

  const rows = mergeRows([...computed.values()]);
  const next = new Map(rows.map((r) => [rowKey(r), r.counters]));
  const stored = await StatsDailyModel.find({
    accountId: input.accountId,
    day: { $gte: from, $lte: to },
  }).lean<StatsDailyDoc[]>();
  const current = new Map(
    stored.map((s) => [
      rowKey(s),
      Object.fromEntries(Object.entries(s.counters as unknown as Record<string, number>)),
    ]),
  );
  let differences = 0;
  for (const k of new Set([...next.keys(), ...current.keys()]))
    if (!sameCounters(next.get(k), current.get(k))) differences += 1;

  if (!input.dryRun && differences > 0) {
    await StatsDailyModel.deleteMany({ accountId: input.accountId, day: { $gte: from, $lte: to } });
    const docs = rows.map((r) => ({
      accountId: input.accountId,
      day: r.day,
      channel: r.channel,
      test: r.test,
      kind: r.kind,
      refId: r.refId,
      counters: r.counters,
    }));
    for (let i = 0; i < docs.length; i += BATCH)
      await StatsDailyModel.insertMany(docs.slice(i, i + BATCH), { ordered: false });
  }
  return { from, to, rows: next.size, differences, written: !input.dryRun && differences > 0 };
};
