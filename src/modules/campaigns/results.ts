import { TZDate } from '@date-fns/tz';

import type { CallEndReason, CallStatus } from '../../db/models/call.model';
import {
  DUE_RANK,
  type CallResult,
  type CampaignContactStatus,
  type DueRank,
} from '../../db/models/campaign-contact.model';
import type { CampaignDoc, SkipReason } from '../../db/models/campaign.model';

import { canDialAt, nextWindowStart, toMinutes } from './window';

/** Dispositions that close a contact for this campaign. */
export const FINAL_DISPOSITIONS = new Set([
  'paid',
  'refused_to_pay',
  'dispute',
  'not_interested',
  'language_barrier',
  'wrong_number',
  'other',
]);

/** Call ends that are not the customer's fault: re-dialed, not counted as an attempt. */
export const NOT_COUNTED: readonly CallEndReason[] = ['server_shutdown', 'limit', 'wallet_empty'];

/** Technical failures (circuit breaker). */
export const TECHNICAL: readonly CallEndReason[] = [
  'engine_error',
  'media_error',
  'ai_failed',
  'media_timeout',
];

export interface ResultCall {
  status: CallStatus;
  endReason: CallEndReason | null;
  answered: boolean;
  disposition: string | null;
  outcome: {
    callback?: { date: string; time: string | null } | null;
    promiseToPay?: { date: string; amountMicros: number | null } | null;
  };
  costMicros: number;
}

export type ResultCampaign = Pick<
  CampaignDoc,
  'retry' | 'followUps' | 'window' | 'schedule' | 'dryRun' | 'mode'
>;

export interface ContactOutcome {
  status: CampaignContactStatus;
  dueRank: DueRank;
  nextAttemptAt: Date | null;
  /** `false`: the attempt is given back (re-dialed without counting). */
  countsAttempt: boolean;
  lastResult: CallResult;
  skipReason: SkipReason | null;
  disposition: string | null;
  callback: { date: string; time: string | null } | null;
  promiseToPay: { date: string; amountMicros: number | null } | null;
  /** The call failed for a technical reason (circuit breaker). */
  technical: boolean;
}

export const lastResultOf = (call: ResultCall): CallResult => {
  if (call.answered) return 'answered';
  if (call.status === 'busy') return 'busy';
  if (call.status === 'no_answer') return 'no_answer';
  if (call.endReason === 'invalid_number') return 'invalid_number';
  return 'failed';
};

/** `ymd` + `HH:mm` in the campaign timezone. */
export const localTime = (ymd: string, hhmm: string, tz: string): Date => {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  const minutes = toMinutes(hhmm);
  return new Date(new TZDate(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, tz).getTime());
};

/** A time moved into the calling window (unchanged when dialing is allowed then). */
export const intoWindow = (at: Date, c: ResultCampaign): Date | null =>
  canDialAt(at, c.window, c.schedule.timezone)
    ? at
    : nextWindowStart(at, c.window, c.schedule.timezone);

/** Retry delay: the interval, divided by the dry-run speed (virtual time). */
export const retryDelayMs = (c: ResultCampaign): number =>
  Math.round((c.retry.intervalMinutes * 60_000) / (c.dryRun ? c.dryRun.speed : 1));

/**
 * What a finished call means for its campaign contact (PHASE_8_PLAN §1i,
 * PHASE_8_PROMPT §1 "Results"). Pure. `attempts` already counts this call.
 */
export const classifyResult = (input: {
  call: ResultCall;
  campaign: ResultCampaign;
  attempts: number;
  now: Date;
}): ContactOutcome => {
  const { call, campaign: c, attempts, now } = input;
  const lastResult = lastResultOf(call);
  const technical = call.endReason !== null && TECHNICAL.includes(call.endReason);
  const base = {
    countsAttempt: true,
    lastResult,
    skipReason: null,
    disposition: call.disposition,
    callback: call.outcome.callback ?? null,
    promiseToPay: call.outcome.promiseToPay ?? null,
    technical,
  };
  const done = (
    status: CampaignContactStatus,
    extra: Partial<ContactOutcome> = {},
  ): ContactOutcome => ({
    ...base,
    status,
    dueRank: DUE_RANK.fresh,
    nextAttemptAt: null,
    ...extra,
  });
  const endAt = c.schedule.endAt;
  const wait = (
    at: Date | null,
    rank: DueRank,
    extra: Partial<ContactOutcome> = {},
  ): ContactOutcome | null =>
    at && (!endAt || at.getTime() < endAt.getTime())
      ? {
          ...base,
          status: rank === DUE_RANK.callback ? 'callback_wait' : 'retry_wait',
          dueRank: rank,
          nextAttemptAt: at,
          ...extra,
        }
      : null;
  const retry = (on: 'no_answer' | 'busy' | 'failed' | 'no_outcome', otherwise: ContactOutcome) => {
    if (!c.retry.retryOn.includes(on) || attempts >= c.retry.maxAttempts) return otherwise;
    return (
      wait(intoWindow(new Date(now.getTime() + retryDelayMs(c)), c), DUE_RANK.retry) ?? otherwise
    );
  };

  if (call.endReason === 'campaign_canceled') return done('canceled');
  if (call.endReason !== null && NOT_COUNTED.includes(call.endReason)) {
    return (
      wait(intoWindow(now, c), DUE_RANK.retry, { countsAttempt: false }) ??
      done('failed', { countsAttempt: false, skipReason: 'campaign_ended' })
    );
  }
  if (lastResult === 'invalid_number') return done('failed', { skipReason: 'invalid_phone' });
  if (lastResult !== 'answered') return retry(lastResult, done('failed'));

  const d = call.disposition;
  if (d === 'promise_to_pay') {
    const promise = call.outcome.promiseToPay;
    if (c.followUps.promiseCheck.enabled && promise?.date) {
      const day = new Date(
        localTime(promise.date, c.window.start, c.schedule.timezone).getTime() +
          c.followUps.promiseCheck.daysAfter * 86_400_000,
      );
      return wait(intoWindow(day, c), DUE_RANK.callback) ?? done('completed');
    }
    return done('completed');
  }
  if (d === 'callback_requested' && call.outcome.callback?.date) {
    if (!c.followUps.callbacks) return done('completed');
    const at = localTime(
      call.outcome.callback.date,
      call.outcome.callback.time ?? c.window.start,
      c.schedule.timezone,
    );
    const horizon = now.getTime() + c.followUps.callbackMaxDays * 86_400_000;
    const when = intoWindow(at.getTime() < now.getTime() ? now : at, c);
    if (!when || when.getTime() > horizon) return done('completed');
    return wait(when, DUE_RANK.callback) ?? done('completed');
  }
  if (d && FINAL_DISPOSITIONS.has(d)) return done('completed');
  // answered without an outcome (hung up early, silence, callback without a date)
  return retry('no_outcome', done('completed'));
};
