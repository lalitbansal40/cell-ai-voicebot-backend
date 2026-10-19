import { describe, expect, it } from 'vitest';

import { defaultDryRun, SCENARIO_KEYS, type ScenarioKey } from '../../db/models/campaign.model';
import { FakeClock } from '../voice/clock';

import type { DryRunLeg } from './dryrun';
import { DryRunProvider, pickOutcome, planDryRun, seededRng } from './dryrun';
import {
  genericScript,
  GENERIC_PHRASES,
  PHRASES,
  pickScenario,
  scriptFor,
  TEMPLATE_SCRIPTS,
} from './scenarios';

const ONLY = (key: ScenarioKey): Record<ScenarioKey, number> =>
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, k === key ? 100 : 0])) as Record<
    ScenarioKey,
    number
  >;
const ANSWER = { answered: 10_000, no_answer: 0, busy: 0, failed: 0, invalid_number: 0 };

describe('seeded randomness', () => {
  it('same seed → same numbers; different seeds differ; values in [0, 1)', () => {
    const a = seededRng('cc1:1');
    const b = seededRng('cc1:1');
    const c = seededRng('cc1:2');
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(c()).not.toBe(first[0]);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('the default mix holds over 10 000 seeds (±2 %)', () => {
    const mix = defaultDryRun().mix;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i += 1) {
      const o = pickOutcome(mix, seededRng(`seed-${String(i)}`));
      counts[o] = (counts[o] ?? 0) + 1;
    }
    for (const [key, bps] of Object.entries(mix)) {
      expect(Math.abs((counts[key] ?? 0) - bps)).toBeLessThanOrEqual(200);
    }
    expect(pickOutcome({ ...ANSWER, answered: 0, busy: 10_000 }, () => 0.99)).toBe('busy');
    expect(pickOutcome(ANSWER, () => 0.5)).toBe('answered');
  });

  it('scenario weights: only the weighted ones, all zero → silence', () => {
    expect(pickScenario(ONLY('callback'), () => 0.7)).toBe('callback');
    const zero = ONLY('paid');
    zero.paid = 0;
    expect(pickScenario(zero, () => 0.3)).toBe('silence');
    const seen = new Set<ScenarioKey>();
    const rng = seededRng('weights');
    for (let i = 0; i < 2_000; i += 1) seen.add(pickScenario(defaultDryRun().scenarios, rng));
    expect([...seen].sort()).toEqual([...SCENARIO_KEYS].sort());
    // negative weights count as zero
    expect(pickScenario({ ...ONLY('refuse'), paid: -50 }, () => 0.5)).toBe('refuse');
    expect(pickScenario(ONLY('paid'), () => 0.9999999999999999)).toBe('paid');
  });
});

describe('scripts', () => {
  it('every template has a script for every scenario; unknown templates get the generic one', () => {
    for (const script of Object.values(TEMPLATE_SCRIPTS)) {
      expect(Object.keys(script).sort()).toEqual([...SCENARIO_KEYS].sort());
    }
    expect(scriptFor('loan_recovery', 'promise', () => 0)).toEqual([
      { dtmf: '1' },
      { say: PHRASES.promise },
      { say: PHRASES.ok },
    ]);
    expect(scriptFor('payment_reminder', 'promise', () => 0)).toEqual([
      { dtmf: '2' },
      { dtmf: '3#' },
    ]);
    const generic = scriptFor(null, 'paid', seededRng('g'));
    expect(generic).toHaveLength(8);
    expect(generic.at(-1)).toEqual({ hangup: true });
    expect(scriptFor('custom_template', 'paid', seededRng('g'))).toEqual(generic);
  });

  it('generic steps: keys 1–3, phrases from the bank, silences', () => {
    const steps = new Set<string>();
    const rng = seededRng('generic');
    for (let i = 0; i < 200; i += 1) {
      for (const step of genericScript(rng)) {
        if ('dtmf' in step) expect(['1', '2', '3']).toContain(step.dtmf);
        if ('say' in step) expect(GENERIC_PHRASES).toContain(step.say);
        steps.add(Object.keys(step)[0] ?? '');
      }
    }
    expect([...steps].sort()).toEqual(['dtmf', 'hangup', 'say', 'wait']);
  });
});

describe('DryRunLeg', () => {
  const settings = (over: Partial<Parameters<typeof planDryRun>[0]> = {}) => ({
    seed: 'leg-1',
    mix: ANSWER,
    scenarios: ONLY('paid'),
    templateKey: 'loan_recovery',
    ...over,
  });
  const start = (over: Parameters<typeof settings>[0] = {}) => {
    const clock = new FakeClock(0);
    const leg = new DryRunProvider().startCall({
      callId: 'c1',
      to: '+919000500001',
      clock,
      dryRun: settings(over),
    });
    const statuses: string[] = [];
    const keys: string[] = [];
    const words: string[] = [];
    leg.onStatus((s, cause) => statuses.push(cause ? `${s}:${cause}` : s));
    leg.onDtmf((k) => keys.push(k));
    leg.onText((t) => words.push(t));
    leg.onAudio();
    leg.onOutgoing();
    return { clock, leg, statuses, keys, words };
  };
  const botLine = (leg: DryRunLeg) =>
    leg.notify({ type: 'call.transcript', speaker: 'bot', text: 'x', final: true });

  it('rings 3–12 s, then answers; nothing happens before the ring', () => {
    const { clock, leg, statuses } = start();
    expect(leg.plan.ringMs).toBeGreaterThanOrEqual(3_000);
    expect(leg.plan.ringMs).toBeLessThan(12_000);
    botLine(leg); // not answered yet: ignored
    leg.ring();
    clock.advance(leg.plan.ringMs - 1);
    expect(statuses).toEqual([]);
    clock.advance(1);
    expect(statuses).toEqual(['answered']);
    expect(leg.rate).toBe(24_000);
  });

  it('pre-answer endings map to hang-up causes', () => {
    const cases = [
      ['no_answer', 'ended:no_answer'],
      ['busy', 'ended:busy'],
      ['failed', 'ended:media_error'],
      ['invalid_number', 'ended:invalid_number'],
    ] as const;
    for (const [outcome, status] of cases) {
      const mix = { answered: 0, no_answer: 0, busy: 0, failed: 0, invalid_number: 0 };
      mix[outcome] = 10_000;
      const { clock, leg, statuses } = start({ mix });
      leg.ring();
      clock.advance(12_000);
      expect(statuses).toEqual([status]);
    }
  });

  it('plays clips on the clock; clearing returns the played ms; a new clip cuts the old one', async () => {
    const { clock, leg } = start();
    let started = false;
    const p = leg.play(new Int16Array(24_000), () => (started = true)); // 1 s
    expect(started).toBe(true);
    expect(leg.playing).toBe(true);
    clock.advance(400);
    expect(leg.clearAudio()).toBe(400);
    expect(await p).toEqual({ completed: false, playedMs: 400 });
    expect(leg.clearAudio()).toBe(0);
    const first = leg.play(new Int16Array(24_000));
    const second = leg.play(new Int16Array(2_400));
    expect(await first).toMatchObject({ completed: false });
    clock.advance(100);
    expect(await second).toEqual({ completed: true, playedMs: 100 });
    expect(leg.playing).toBe(false);
  });

  it('the customer acts after each finished bot line (think time), waiting while the bot talks', async () => {
    const { clock, leg, keys, words, statuses } = start({ scenarios: ONLY('promise') });
    leg.ring();
    clock.advance(12_000);
    leg.notify({ type: 'call.transcript', speaker: 'bot', text: 'x', final: false }); // partial
    leg.notify({ type: 'call.event' });
    leg.notify({ type: 'call.transcript', speaker: 'customer', text: 'x', final: true });
    clock.advance(5_000);
    expect(keys).toEqual([]);
    botLine(leg);
    void leg.play(new Int16Array(24_000 * 10)); // the bot goes on talking
    clock.advance(3_000);
    expect(keys).toEqual([]); // skipped: the next bot line will trigger it
    leg.clearAudio();
    botLine(leg);
    botLine(leg); // a second line resets the think timer
    clock.advance(3_000);
    expect(keys).toEqual(['1']);
    botLine(leg);
    clock.advance(3_000);
    expect(words).toEqual([PHRASES.promise]);
    botLine(leg);
    clock.advance(3_000);
    botLine(leg);
    clock.advance(3_000); // script done → hangs up
    expect(statuses.at(-1)).toBe('ended:customer_hangup');
    botLine(leg); // after the end: ignored
    expect(await leg.play(new Int16Array(10))).toEqual({ completed: false, playedMs: 0 });
  });

  it('multi-key steps send every key; hang-up steps end the call; transfers are answered', async () => {
    const reminder = start({ templateKey: 'payment_reminder', scenarios: ONLY('promise') });
    reminder.leg.ring();
    reminder.clock.advance(12_000);
    botLine(reminder.leg);
    reminder.clock.advance(3_000);
    botLine(reminder.leg);
    reminder.clock.advance(3_000);
    expect(reminder.keys).toEqual(['2', '3', '#']);

    const early = start({ scenarios: ONLY('hangup_early') });
    early.leg.ring();
    early.clock.advance(12_000);
    botLine(early.leg);
    early.clock.advance(3_000);
    expect(early.statuses).toEqual(['answered', 'ended:customer_hangup']);

    const t = start();
    const transfer = t.leg.transfer();
    t.clock.advance(2_000);
    expect(['connected', 'no_answer']).toContain(await transfer);
    await t.leg.hangup();
    t.clock.advance(20_000);
    expect(t.statuses).toEqual([]); // a server hang-up does not report back
  });

  it('the same seed plans the same call', () => {
    expect(planDryRun(settings({ seed: 'same' }))).toEqual(planDryRun(settings({ seed: 'same' })));
  });
});
