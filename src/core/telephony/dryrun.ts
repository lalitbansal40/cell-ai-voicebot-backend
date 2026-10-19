import { createHash } from 'node:crypto';

import type { DryRunOutcome, ScenarioKey } from '../../db/models/campaign.model';
import type { PlaybackResult } from '../voice/audio/pacer';
import type { Clock } from '../voice/clock';

import { pickScenario, scriptFor, type CustomerStep } from './scenarios';
import type {
  CallLeg,
  HangupCause,
  LegNotice,
  LegStatus,
  StartCallRequest,
  TelephonyProvider,
  TransferResult,
} from './types';

/** Deterministic 32-bit PRNG (mulberry32) from a string seed (sha256). */
export const seededRng = (seed: string): (() => number) => {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Pre-answer outcome by the mix (basis points; the remainder counts as answered). */
export const pickOutcome = (
  mix: Record<DryRunOutcome, number>,
  rng: () => number,
): DryRunOutcome => {
  let roll = rng() * 10_000;
  for (const key of ['no_answer', 'busy', 'failed', 'invalid_number'] as const) {
    roll -= mix[key];
    if (roll < 0) return key;
  }
  return 'answered';
};

const ENDED_BY: Record<Exclude<DryRunOutcome, 'answered'>, HangupCause> = {
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'media_error',
  invalid_number: 'invalid_number',
};

export interface DryRunSettings {
  seed: string;
  mix: Record<DryRunOutcome, number>;
  scenarios: Record<ScenarioKey, number>;
  /** `Flow.templateKey` of the flow on the call (scripts per template). */
  templateKey: string | null;
}

export interface DryRunCallRequest extends StartCallRequest {
  dryRun: DryRunSettings;
  clock: Clock;
}

/** What the leg decided (tests, events). */
export interface DryRunPlan {
  outcome: DryRunOutcome;
  ringMs: number;
  scenario: ScenarioKey;
  steps: CustomerStep[];
}

export const planDryRun = (settings: DryRunSettings): DryRunPlan => {
  const rng = seededRng(settings.seed);
  const ringMs = 3000 + Math.floor(rng() * 9000);
  const outcome = pickOutcome(settings.mix, rng);
  const scenario = pickScenario(settings.scenarios, rng);
  return { outcome, ringMs, scenario, steps: scriptFor(settings.templateKey, scenario, rng) };
};

/**
 * A simulated phone leg: rings, then answers or ends (busy / no answer /
 * failed / invalid number); while answered a simulated customer reacts to
 * every finished bot line. Audio is never sent anywhere — `play()` only takes
 * the clip's time on the (scaled) clock.
 */
export class DryRunLeg implements CallLeg {
  readonly rate = 24_000;
  readonly plan: DryRunPlan;
  private readonly statusFns: ((status: LegStatus, cause?: HangupCause) => void)[] = [];
  private readonly dtmfFns: ((digit: string) => void)[] = [];
  private readonly textFns: ((text: string) => void)[] = [];
  private readonly timers = new Set<unknown>();
  private current: {
    startedAt: number;
    ms: number;
    timer: unknown;
    resolve: (r: PlaybackResult) => void;
  } | null = null;
  private stepIndex = 0;
  private ended = false;
  private answered = false;
  private pendingAct: unknown = null;
  private readonly rng: () => number;

  constructor(
    private readonly clock: Clock,
    settings: DryRunSettings,
  ) {
    this.plan = planDryRun(settings);
    this.rng = seededRng(`${settings.seed}:think`);
  }

  /** Starts ringing (the session is listening by now). */
  ring(): void {
    this.later(() => {
      if (this.plan.outcome === 'answered') {
        this.answered = true;
        this.emit('answered');
      } else this.finish(ENDED_BY[this.plan.outcome]);
    }, this.plan.ringMs);
  }

  get playing(): boolean {
    return this.current !== null;
  }

  onAudio(): void {
    // no customer audio on a simulated line
  }

  onOutgoing(): void {
    // nothing is recorded on a simulated line
  }

  onDtmf(fn: (digit: string) => void): void {
    this.dtmfFns.push(fn);
  }

  onText(fn: (text: string) => void): void {
    this.textFns.push(fn);
  }

  onStatus(fn: (status: LegStatus, cause?: HangupCause) => void): void {
    this.statusFns.push(fn);
  }

  play(pcm: Int16Array, onStart?: () => void): Promise<PlaybackResult> {
    if (this.ended) return Promise.resolve({ completed: false, playedMs: 0 });
    onStart?.();
    this.clearAudio();
    const ms = Math.round(pcm.length / (this.rate / 1000));
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.current = null;
        resolve({ completed: true, playedMs: ms });
      }, ms);
      this.current = { startedAt: this.clock.now(), ms, timer, resolve };
    });
  }

  clearAudio(): number {
    const c = this.current;
    if (!c) return 0;
    this.clock.clearTimeout(c.timer);
    this.current = null;
    const played = Math.min(c.ms, Math.max(0, Math.round(this.clock.now() - c.startedAt)));
    c.resolve({ completed: false, playedMs: played });
    return played;
  }

  transfer(): Promise<TransferResult> {
    const result: TransferResult = this.rng() < 0.5 ? 'connected' : 'no_answer';
    return new Promise((resolve) => this.later(() => resolve(result), 2000));
  }

  notify(notice: LegNotice): void {
    if (this.ended || !this.answered) return;
    if (notice.type === 'call.transcript' && notice.final === true && notice.speaker === 'bot') {
      this.scheduleAct();
    }
  }

  hangup(): Promise<void> {
    this.stop();
    return Promise.resolve();
  }

  private scheduleAct(): void {
    if (this.pendingAct !== null) this.clock.clearTimeout(this.pendingAct);
    this.pendingAct = this.later(
      () => {
        this.pendingAct = null;
        // the bot is talking again — act when that line is done
        if (this.current) return;
        this.act();
      },
      1000 + Math.floor(this.rng() * 2000),
    );
  }

  private act(): void {
    const step = this.plan.steps[this.stepIndex];
    this.stepIndex += 1;
    if (!step || 'hangup' in step) {
      this.finish('customer_hangup');
      return;
    }
    if ('dtmf' in step) for (const key of step.dtmf) for (const fn of this.dtmfFns) fn(key);
    else if ('say' in step) for (const fn of this.textFns) fn(step.say);
  }

  private later(fn: () => void, ms: number): unknown {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      if (!this.ended) fn();
    }, ms);
    this.timers.add(handle);
    return handle;
  }

  private emit(status: LegStatus, cause?: HangupCause): void {
    for (const fn of this.statusFns) fn(status, cause);
  }

  private finish(cause: HangupCause): void {
    if (this.ended) return;
    this.stop();
    this.emit('ended', cause);
  }

  private stop(): void {
    this.ended = true;
    this.clearAudio();
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
  }
}

/** Simulated phone line for dry runs (`Call.provider: 'dryrun'`). */
export class DryRunProvider {
  readonly name = 'dryrun' as const;

  startCall(request: DryRunCallRequest): DryRunLeg {
    return new DryRunLeg(request.clock, request.dryRun);
  }
}

export type { TelephonyProvider };
