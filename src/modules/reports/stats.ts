/** Reading the rollups (`statsDaily`) for reports: sums, per-day series, ratios, bucket quantiles. */
import type { Types } from 'mongoose';

import {
  StatsDailyModel,
  type StatsChannel,
  type StatsKind,
} from '../../db/models/stats-daily.model';
import { addDays } from '../../shared/time';

export type Counters = Record<string, number>;

export interface StatsRow {
  day: string;
  channel: StatsChannel;
  test: boolean;
  kind: StatsKind;
  refId: Types.ObjectId | null;
  counters: Counters;
}

export interface StatsQuery {
  accountId: Types.ObjectId;
  from: string;
  to: string;
  kind: StatsKind;
  /** `undefined` = every row of the kind (tables group by it); `null` = the account row. */
  refId?: Types.ObjectId | null;
  channels: readonly StatsChannel[];
  includeTest: boolean;
}

export const loadStats = async (q: StatsQuery): Promise<StatsRow[]> =>
  StatsDailyModel.find({
    accountId: q.accountId,
    kind: q.kind,
    ...(q.refId === undefined ? {} : { refId: q.refId }),
    day: { $gte: q.from, $lte: q.to },
    channel: { $in: q.channels },
    ...(q.includeTest ? {} : { test: false }),
  })
    .select({ day: 1, channel: 1, test: 1, kind: 1, refId: 1, counters: 1 })
    .lean<StatsRow[]>();

export const add = (into: Counters, from: Counters): Counters => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  return into;
};

export const sum = (rows: StatsRow[]): Counters =>
  rows.reduce<Counters>((c, r) => add(c, r.counters), {});

/** Every day of the range (inclusive). */
export const daysOf = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export const byDay = (rows: StatsRow[]): Map<string, Counters> => {
  const out = new Map<string, Counters>();
  for (const r of rows) out.set(r.day, add(out.get(r.day) ?? {}, r.counters));
  return out;
};

export const byRef = (rows: StatsRow[]): Map<string, Counters> => {
  const out = new Map<string, Counters>();
  for (const r of rows) {
    if (!r.refId) continue;
    const key = r.refId.toString();
    out.set(key, add(out.get(key) ?? {}, r.counters));
  }
  return out;
};

/** `a ÷ b` as a percentage with one decimal; `null` when `b` is 0. */
export const pct = (a: number | undefined, b: number | undefined): number | null =>
  b ? Math.round(((a ?? 0) / b) * 1000) / 10 : null;

/** `a ÷ b` rounded; `null` when `b` is 0. */
export const avg = (a: number | undefined, b: number | undefined): number | null =>
  b ? Math.round((a ?? 0) / b) : null;

/**
 * Quantile from bucket counters (`<prefix>0` … `<prefix>n`, lower bounds `buckets`):
 * the lower bound of the bucket holding the `q` share — an "at least" value.
 */
export const bucketQuantile = (
  c: Counters,
  prefix: string,
  buckets: readonly number[],
  q: number,
): number | null => {
  const counts = buckets.map((_, i) => c[`${prefix}${String(i)}`] ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = Math.max(1, Math.ceil(total * q));
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i] ?? 0;
    if (seen >= target) return buckets[i] ?? null;
  }
  return buckets[buckets.length - 1] ?? null;
};

/** Keys of keyed counters (`outcome_promise_to_pay` → `promise_to_pay`). */
export const keyed = (c: Counters, prefix: string): [string, number][] =>
  Object.entries(c)
    .filter(([k, v]) => k.startsWith(prefix) && v > 0)
    .map(([k, v]) => [k.slice(prefix.length), v] as [string, number])
    .sort((a, b) => b[1] - a[1]);
