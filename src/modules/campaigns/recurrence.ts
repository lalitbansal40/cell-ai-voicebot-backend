import { TZDate } from '@date-fns/tz';

import type { CampaignRecurrence } from '../../db/models/campaign.model';

/** Days looked ahead for the next occurrence (weekly on one day → ≤ 7; DST gaps aside). */
const LOOKAHEAD_DAYS = 400;

const hm = (time: string): [number, number] => time.split(':').map(Number) as [number, number];

/**
 * The next `n` occurrences strictly after `from` (PHASE_8_PLAN §1g): daily or on
 * the weekly days (0 = Sunday) at `time` in `timezone`, never after `until`.
 * A local time skipped by a DST jump moves forward (TZDate), so a run is never lost.
 */
export const nextOccurrences = (
  recurrence: Pick<CampaignRecurrence, 'freq' | 'days' | 'time' | 'until'>,
  timezone: string,
  from: Date,
  n: number,
): Date[] => {
  const [hour, minute] = hm(recurrence.time);
  const today = new TZDate(from.getTime(), timezone);
  const out: Date[] = [];
  for (let i = 0; i <= LOOKAHEAD_DAYS && out.length < n; i += 1) {
    const day = new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + i, timezone);
    if (recurrence.freq === 'weekly' && !recurrence.days.includes(day.getDay())) continue;
    const at = new TZDate(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, timezone);
    if (at.getTime() <= from.getTime()) continue;
    if (recurrence.until && at.getTime() > recurrence.until.getTime()) break;
    out.push(new Date(at.getTime()));
  }
  return out;
};

export const nextOccurrence = (
  recurrence: CampaignRecurrence,
  timezone: string,
  from: Date,
): Date | null => nextOccurrences(recurrence, timezone, from, 1)[0] ?? null;

/** Cron pattern for BullMQ `upsertJobScheduler` (with `tz`): `m h * * *` or `m h * * d,d`. */
export const cronOf = (recurrence: Pick<CampaignRecurrence, 'freq' | 'days' | 'time'>): string => {
  const [hour, minute] = hm(recurrence.time);
  const days = recurrence.freq === 'daily' ? '*' : [...recurrence.days].sort().join(',');
  return `${String(minute)} ${String(hour)} * * ${days}`;
};

/** `d MMM` of `at` in `timezone` — run names ("Loan reminder · 16 Oct"). */
export const runLabel = (at: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: timezone }).format(
    at,
  );

/** First occurrence of a recurring campaign that becomes scheduled now (not before `startAt`). */
export const firstRunAt = (
  schedule: { startAt: Date | null; timezone: string; recurrence: CampaignRecurrence | null },
  now: Date,
): Date | null => {
  if (!schedule.recurrence) return null;
  const from =
    schedule.startAt && schedule.startAt.getTime() > now.getTime()
      ? new Date(schedule.startAt.getTime() - 1)
      : now;
  return nextOccurrence(schedule.recurrence, schedule.timezone, from);
};
