import { TZDate } from '@date-fns/tz';
import { addDays, addWeeks, startOfDay, startOfISOWeek } from 'date-fns';

/**
 * Per-contact call caps (PHASE_8_PLAN §1d): calls are counted per local day
 * and ISO week (Monday start) in the account timezone.
 */
export interface CapBounds {
  dayStart: Date;
  weekStart: Date;
  nextDayStart: Date;
  nextWeekStart: Date;
}

export const capBounds = (now: Date, tz: string): CapBounds => {
  const local = new TZDate(now.getTime(), tz);
  const day = startOfDay(local);
  const week = startOfISOWeek(local);
  return {
    dayStart: new Date(day.getTime()),
    weekStart: new Date(week.getTime()),
    nextDayStart: new Date(addDays(day, 1).getTime()),
    nextWeekStart: new Date(addWeeks(week, 1).getTime()),
  };
};
