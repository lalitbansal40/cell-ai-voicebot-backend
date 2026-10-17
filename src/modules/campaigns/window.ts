import { TZDate } from '@date-fns/tz';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import type { CampaignWindow } from '../../db/models/campaign.model';

/**
 * Calling-window math (PHASE_8_PROMPT §1 "Window math") — pure, no IO.
 * Windows are `[start, end)` local times (`HH:mm`) on `days` (0 = Sunday)
 * in an IANA timezone; no overnight windows (start < end).
 */

export const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** `HH:mm` → minutes after midnight. */
export const toMinutes = (hhmm: string): number => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** Minutes after midnight → `HH:mm`. */
export const fromMinutes = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Weekday + minutes after local midnight (with seconds as a fraction) of `now` in `tz`. */
export const localClock = (now: Date, tz: string): { day: number; minutes: number } => {
  const d = new TZDate(now.getTime(), tz);
  return {
    day: d.getDay(),
    minutes: d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60,
  };
};

const isUsable = (w: CampaignWindow): boolean =>
  w.days.length > 0 && toMinutes(w.start) < toMinutes(w.end);

/** `now` is inside the window (start inclusive, end exclusive). */
export const isInWindow = (now: Date, w: CampaignWindow, tz: string): boolean => {
  if (!isUsable(w)) return false;
  const { day, minutes } = localClock(now, tz);
  return w.days.includes(day) && minutes >= toMinutes(w.start) && minutes < toMinutes(w.end);
};

/** A new call may start now: inside the window and at least `bufferMin` before its end. */
export const canDialAt = (
  now: Date,
  w: CampaignWindow,
  tz: string,
  bufferMin: number = CAMPAIGN_LIMITS.windowEndBufferMin,
): boolean => isInWindow(now, w, tz) && toMinutes(w.end) - localClock(now, tz).minutes >= bufferMin;

/** The window start of the local day `offset` days after `from` (DST-safe via `TZDate`). */
const startOn = (from: Date, offset: number, w: CampaignWindow, tz: string): TZDate => {
  const local = new TZDate(from.getTime(), tz);
  const minutes = toMinutes(w.start);
  return new TZDate(
    local.getFullYear(),
    local.getMonth(),
    local.getDate() + offset,
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    tz,
  );
};

/**
 * When a new call may start next: `now` when dialing is allowed now, else the
 * next window start (searched over 8 days). `null` for an unusable window.
 */
export const nextWindowStart = (
  now: Date,
  w: CampaignWindow,
  tz: string,
  bufferMin: number = CAMPAIGN_LIMITS.windowEndBufferMin,
): Date | null => {
  if (!isUsable(w)) return null;
  if (canDialAt(now, w, tz, bufferMin)) return now;
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = startOn(now, offset, w, tz);
    if (candidate.getTime() > now.getTime() && w.days.includes(candidate.getDay())) {
      return new Date(candidate.getTime());
    }
  }
  return null;
};

/**
 * The first window start on or after the local day of `from` + `days` (caps,
 * callbacks). A window without days falls back to that day's start time.
 */
export const windowStartFromDay = (
  from: Date,
  days: number,
  w: CampaignWindow,
  tz: string,
): Date => {
  for (let offset = days; offset <= days + 7; offset += 1) {
    const candidate = startOn(from, offset, w, tz);
    if (w.days.includes(candidate.getDay())) return new Date(candidate.getTime());
  }
  return new Date(startOn(from, days, w, tz).getTime());
};

/** Common part of two windows (later start, earlier end, shared days); `null` when empty. */
export const intersect = (a: CampaignWindow, b: CampaignWindow): CampaignWindow | null => {
  const start = Math.max(toMinutes(a.start), toMinutes(b.start));
  const end = Math.min(toMinutes(a.end), toMinutes(b.end));
  const days = a.days.filter((d) => b.days.includes(d)).sort((x, y) => x - y);
  if (start >= end || days.length === 0) return null;
  return { start: fromMinutes(start), end: fromMinutes(end), days: [...new Set(days)] };
};

export interface EffectiveWindowInput {
  account: CampaignWindow;
  campaign: CampaignWindow;
  /** Real phone calls (not a dry run) — compliance hard bounds apply. */
  live: boolean;
  /** The pinned flow version uses a recovery agent (RBI 08:00–19:00). */
  recovery: boolean;
}

/**
 * Account ∩ campaign ∩ (live: TRAI 09:00–21:00) ∩ (live + recovery: RBI 08:00–19:00).
 * `null` when nothing is left.
 */
export const effectiveWindow = (input: EffectiveWindowInput): CampaignWindow | null => {
  let w = intersect(input.account, input.campaign);
  if (w && input.live) {
    w = intersect(w, { ...CAMPAIGN_LIMITS.trafficHardWindow, days: [...ALL_DAYS] });
  }
  if (w && input.live && input.recovery) {
    w = intersect(w, { ...CAMPAIGN_LIMITS.recoveryHardWindow, days: [...ALL_DAYS] });
  }
  return w;
};
