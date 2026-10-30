import { TZDate } from '@date-fns/tz';

import type { CallingWindow } from '../../db/models/account.model';
import type { RuleTimingMode } from '../../db/models/outcome-rule.model';
import { isInWindow } from '../campaigns/window';

/** The next full local hour at or after `now` that is inside the calling window (≤ 8 days). */
export const nextWindowHour = (now: Date, window: CallingWindow, tz: string): Date | null => {
  const local = new TZDate(now.getTime(), tz);
  const exact =
    local.getMinutes() === 0 && local.getSeconds() === 0 && local.getMilliseconds() === 0;
  const firstHour = local.getHours() + (exact ? 0 : 1);
  for (let h = 0; h <= 8 * 24; h += 1) {
    const candidate = new TZDate(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      firstHour + h,
      0,
      0,
      tz,
    );
    if (isInWindow(new Date(candidate.getTime()), window, tz)) return new Date(candidate.getTime());
  }
  return null;
};

/** When a rule's message goes out. */
export const scheduledAtFor = (
  timing: { mode: RuleTimingMode; delayMinutes: number | null },
  now: Date,
  window: CallingWindow,
  tz: string,
): Date => {
  if (timing.mode === 'after') return new Date(now.getTime() + (timing.delayMinutes ?? 0) * 60_000);
  if (timing.mode === 'next_window_hour') return nextWindowHour(now, window, tz) ?? now;
  return now;
};
