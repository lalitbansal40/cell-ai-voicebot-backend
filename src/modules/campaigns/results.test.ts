import { describe, expect, it } from 'vitest';

import {
  classifyResult,
  intoWindow,
  lastResultOf,
  localTime,
  retryDelayMs,
  type ResultCall,
  type ResultCampaign,
} from './results';

const IST = 'Asia/Kolkata';
const ist = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`);
const NOW = ist('2026-10-19', '10:00'); // Monday

const campaign = (over: Partial<ResultCampaign> = {}): ResultCampaign => ({
  mode: 'dry_run',
  retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['no_answer', 'busy', 'failed'] },
  followUps: {
    callbacks: true,
    callbackMaxDays: 7,
    promiseCheck: { enabled: false, daysAfter: 1 },
  },
  window: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
  schedule: { startAt: null, endAt: null, timezone: IST, recurrence: null },
  dryRun: null,
  ...over,
});
const call = (over: Partial<ResultCall> = {}): ResultCall => ({
  status: 'completed',
  endReason: 'hangup_node',
  answered: true,
  disposition: null,
  outcome: {},
  costMicros: 100,
  ...over,
});
const run = (c: Partial<ResultCall>, camp: Partial<ResultCampaign> = {}, attempts = 1) =>
  classifyResult({ call: call(c), campaign: campaign(camp), attempts, now: NOW });

describe('classifyResult (PHASE_8_PLAN §1i)', () => {
  it('final dispositions complete the contact', () => {
    for (const d of [
      'paid',
      'refused_to_pay',
      'dispute',
      'not_interested',
      'language_barrier',
      'wrong_number',
      'other',
    ]) {
      expect(run({ disposition: d })).toMatchObject({
        status: 'completed',
        nextAttemptAt: null,
        countsAttempt: true,
        lastResult: 'answered',
        disposition: d,
      });
    }
  });

  it('promise: completed, or a follow-up call days after the promise date', () => {
    const promise = { date: '2026-10-21', amountMicros: null };
    expect(
      run({ disposition: 'promise_to_pay', outcome: { promiseToPay: promise } }),
    ).toMatchObject({
      status: 'completed',
      promiseToPay: promise,
    });
    const check = run(
      { disposition: 'promise_to_pay', outcome: { promiseToPay: promise } },
      {
        followUps: {
          callbacks: true,
          callbackMaxDays: 7,
          promiseCheck: { enabled: true, daysAfter: 2 },
        },
      },
    );
    expect(check).toMatchObject({ status: 'callback_wait', dueRank: 0 });
    expect(check.nextAttemptAt).toEqual(ist('2026-10-23', '09:00'));
    // past the campaign end → done
    expect(
      run(
        { disposition: 'promise_to_pay', outcome: { promiseToPay: promise } },
        {
          followUps: {
            callbacks: true,
            callbackMaxDays: 7,
            promiseCheck: { enabled: true, daysAfter: 2 },
          },
          schedule: {
            startAt: null,
            endAt: ist('2026-10-22', '00:00'),
            timezone: IST,
            recurrence: null,
          },
        },
      ).status,
    ).toBe('completed');
    // no date → completed
    expect(
      run(
        { disposition: 'promise_to_pay' },
        {
          followUps: {
            callbacks: true,
            callbackMaxDays: 7,
            promiseCheck: { enabled: true, daysAfter: 1 },
          },
        },
      ).status,
    ).toBe('completed');
  });

  it('callbacks at the requested time, moved into the window, within the horizon', () => {
    const cb = (date: string, time: string | null, camp: Partial<ResultCampaign> = {}) =>
      run({ disposition: 'callback_requested', outcome: { callback: { date, time } } }, camp);
    expect(cb('2026-10-20', '17:00')).toMatchObject({
      status: 'callback_wait',
      dueRank: 0,
      nextAttemptAt: ist('2026-10-20', '17:00'),
    });
    expect(cb('2026-10-20', '21:00').nextAttemptAt).toEqual(ist('2026-10-21', '09:00'));
    expect(cb('2026-10-20', null).nextAttemptAt).toEqual(ist('2026-10-20', '09:00'));
    expect(cb('2026-10-18', '17:00').nextAttemptAt).toEqual(NOW); // a past time → now
    expect(cb('2026-11-30', '10:00').status).toBe('completed'); // beyond 7 days
    expect(
      cb('2026-10-20', '17:00', {
        followUps: {
          callbacks: false,
          callbackMaxDays: 7,
          promiseCheck: { enabled: false, daysAfter: 1 },
        },
      }).status,
    ).toBe('completed');
    expect(
      cb('2026-10-20', '17:00', {
        schedule: {
          startAt: null,
          endAt: ist('2026-10-20', '12:00'),
          timezone: IST,
          recurrence: null,
        },
      }).status,
    ).toBe('completed');
    expect(
      cb('2026-10-20', '17:00', { window: { start: '09:00', end: '19:00', days: [] } }).status,
    ).toBe('completed');
  });

  it('answered without an outcome: retry when no_outcome is on, else done', () => {
    expect(run({ disposition: null }).status).toBe('completed');
    const r = run(
      { disposition: 'callback_requested' },
      { retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['no_outcome'] } },
    );
    expect(r).toMatchObject({
      status: 'retry_wait',
      dueRank: 1,
      nextAttemptAt: ist('2026-10-19', '11:00'),
    });
  });

  it('busy / no answer / failed retry inside the window up to the max, then fail', () => {
    expect(run({ status: 'busy', endReason: 'busy', answered: false })).toMatchObject({
      status: 'retry_wait',
      lastResult: 'busy',
      nextAttemptAt: ist('2026-10-19', '11:00'),
    });
    expect(
      run({ status: 'no_answer', endReason: 'no_answer', answered: false }, {}, 3),
    ).toMatchObject({
      status: 'failed',
      lastResult: 'no_answer',
    });
    expect(
      run(
        { status: 'failed', endReason: 'media_error', answered: false },
        { retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['busy'] } },
      ),
    ).toMatchObject({ status: 'failed', lastResult: 'failed', technical: true });
    // late in the day → the next window start; dry runs divide the delay by the speed
    const late = classifyResult({
      call: call({ status: 'busy', endReason: 'busy', answered: false }),
      campaign: campaign(),
      attempts: 1,
      now: ist('2026-10-19', '18:30'),
    });
    expect(late.nextAttemptAt).toEqual(ist('2026-10-20', '09:00'));
    const fast = run(
      { status: 'busy', endReason: 'busy', answered: false },
      { dryRun: { mix: {} as never, scenarios: {} as never, speed: 20 } },
    );
    expect(fast.nextAttemptAt).toEqual(new Date(NOW.getTime() + 3 * 60_000));
    // a retry past the end → failed
    expect(
      run(
        { status: 'busy', endReason: 'busy', answered: false },
        {
          schedule: {
            startAt: null,
            endAt: ist('2026-10-19', '10:30'),
            timezone: IST,
            recurrence: null,
          },
        },
      ).status,
    ).toBe('failed');
  });

  it('invalid numbers fail with a skip reason; canceled calls cancel; not-counted ends come back', () => {
    expect(run({ status: 'failed', endReason: 'invalid_number', answered: false })).toMatchObject({
      status: 'failed',
      skipReason: 'invalid_phone',
      lastResult: 'invalid_number',
    });
    expect(run({ endReason: 'campaign_canceled' }).status).toBe('canceled');
    for (const endReason of ['server_shutdown', 'limit', 'wallet_empty'] as const) {
      expect(run({ endReason }, {}, 3)).toMatchObject({
        status: 'retry_wait',
        countsAttempt: false,
        nextAttemptAt: NOW,
      });
    }
    expect(
      run(
        { endReason: 'wallet_empty' },
        {
          schedule: {
            startAt: null,
            endAt: ist('2026-10-19', '09:00'),
            timezone: IST,
            recurrence: null,
          },
        },
      ),
    ).toMatchObject({ status: 'failed', countsAttempt: false, skipReason: 'campaign_ended' });
  });

  it('helpers', () => {
    expect(
      lastResultOf(call({ answered: false, status: 'failed', endReason: 'media_timeout' })),
    ).toBe('failed');
    expect(localTime('2026-10-20', '17:30', IST)).toEqual(ist('2026-10-20', '17:30'));
    expect(intoWindow(ist('2026-10-18', '12:00'), campaign())).toEqual(ist('2026-10-19', '09:00'));
    expect(retryDelayMs(campaign())).toBe(3_600_000);
  });
});
