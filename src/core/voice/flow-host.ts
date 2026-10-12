import { CALL_LIMITS } from '../../config/limits';
import type { CallEndReason } from '../../db/models/call.model';
import type { RunEndReason } from '../../db/models/flow-run.model';
import type { CallIO, CallScript, ScriptResult } from '../../modules/calls/session';
import { advance, runValues } from '../engine/engine';
import type { FlowGraph, NodeConfig } from '../engine/schema';
import type {
  AdvanceResult,
  AiTurnLite,
  AiTurnResult,
  EngineContext,
  FlowEffects,
  FlowInputBody,
  FlowOutput,
  FlowRunState,
  Waiting,
} from '../engine/types';
import type { RunValue } from '../engine/variables';

import type { SttProvider, SttSession } from './providers/types';

/** How a live AI step ended (fed to the engine as `ai_session_end`). */
export interface AiStepEnd {
  outcome: AiTurnResult['outcome'];
  reason: 'outcome' | 'end_call' | 'no_response' | 'max_turns' | 'fallback';
  turns: number;
  aiSeconds: number;
  language: string | null;
}

/** Customer audio / typed text go here while an AI step owns the call. */
export interface AiInputs {
  setAudio(fn: ((frame: Int16Array) => void) | null): void;
  setText(fn: ((text: string) => void) | null): void;
}

export interface AiStepRequest {
  nodeId: string;
  config: NodeConfig<'ai_agent'>;
  values: Record<string, string>;
  /** Turns so far (the opening line the engine already said). */
  turns: AiTurnLite[];
  io: CallIO;
  inputs: AiInputs;
}

export interface FlowHostDeps {
  graph: FlowGraph;
  ctx: EngineContext;
  effects: FlowEffects;
  /** Contact display values for the start input. */
  contact: Record<string, string>;
  seed: Record<string, RunValue>;
  stt: SttProvider;
  /** Account / flow default language for `say` steps with `language: flow / auto`. */
  language: string;
  voice: string;
  /** Decoded 24 kHz audio of a library file (null = missing). */
  loadAudio(audioId: string): Promise<Int16Array | null>;
  /** Runs an `ai_agent` step live (T7.7 controller). */
  runAi(request: AiStepRequest): Promise<AiStepEnd>;
  /** After every engine step (state to Redis, stats flush). */
  onStep?(result: AdvanceResult): Promise<void>;
  /** When the run ends (FlowRun mode `call`). Returns the run id. */
  onFinish?(state: FlowRunState, trace: AdvanceResult['trace']): Promise<string | null>;
}

const RUN_TO_CALL: Record<RunEndReason, CallEndReason> = {
  hangup_node: 'hangup_node',
  transferred: 'transferred',
  customer_hangup: 'customer_hangup',
  max_duration: 'max_duration',
  loop_guard: 'engine_error',
  error_handler: 'hangup_node',
  engine_error: 'engine_error',
  inputs_exhausted: 'engine_error',
};

/** Why the run ended when the call ended outside the flow (wallet, shutdown… → the call is over). */
const CALL_TO_RUN: Partial<Record<CallEndReason, 'max_duration' | 'engine_error'>> = {
  max_duration: 'max_duration',
  engine_error: 'engine_error',
  ai_failed: 'engine_error',
};

const STT_LANG: Record<string, string | null> = { hi: 'hi', en: 'en', hinglish: 'hi', auto: null };

type Pending = { resolve: (input: FlowInputBody | null) => void };

/**
 * Runs a Phase 6 flow live (PHASE_7_PLAN §1g): engine outputs become audio,
 * the waits become key presses, speech, timers, a transfer prompt or a live AI
 * step. Keys pressed while a prompt plays are kept (type-ahead).
 */
export class FlowHost implements CallScript {
  private state: FlowRunState | null = null;
  private trace: AdvanceResult['trace'] = [];
  private stt: SttSession | null = null;
  private io: CallIO | null = null;
  private readonly dtmf: string[] = [];
  private readonly speech: { text: string; language: string | null }[] = [];
  private pending: Pending | null = null;
  private listening: Waiting | null = null;
  private interruptible = false;
  private aiAudio: ((frame: Int16Array) => void) | null = null;
  private aiText: ((text: string) => void) | null = null;
  private aiSeconds = 0;
  private language: string | null = null;
  private stopped = false;
  private flowRunId: string | null = null;
  private finished = false;
  private wakeSpeech: (() => void) | null = null;
  private digitTimer: unknown = null;

  constructor(private readonly deps: FlowHostDeps) {}

  async run(io: CallIO): Promise<CallEndReason | void> {
    this.io = io;
    const stt = await this.deps.stt.open({
      language: STT_LANG[this.deps.language] ?? null,
      rate: io.leg.rate,
    });
    this.stt = stt;
    stt.on('speech_started', () => {
      if (this.interruptible && io.leg.playing) io.interrupt();
      this.wakeSpeech?.();
    });
    stt.on('final', ({ text, language }) => {
      if (!text.trim()) return;
      io.transcript('customer', text, { source: 'stt', language });
      io.customerDone();
      this.language = language ?? this.language;
      this.speech.push({ text, language });
      this.deliver();
    });
    io.leg.onAudio((frame) => {
      if (this.aiAudio) this.aiAudio(frame);
      else this.stt?.sendAudio(frame);
    });
    io.leg.onText((text) => {
      if (this.aiText) this.aiText(text);
      else this.stt?.sendText(text);
    });
    io.leg.onDtmf((digit) => {
      io.transcript('customer', `[${digit}]`, { source: 'dtmf' });
      io.event('dtmf', {});
      io.customerDone();
      if (this.interruptible && io.leg.playing) io.interrupt();
      this.dtmf.push(digit);
      this.deliver();
    });

    let result = await this.step({ kind: 'start', trigger: 'test' });
    for (;;) {
      await this.perform(result.outputs);
      if (this.stopped) return;
      if (!result.waiting) return RUN_TO_CALL[result.state.endReason ?? 'hangup_node'];
      const input = await this.inputFor(result.waiting);
      if (!input || this.stopped) return;
      result = await this.step(input);
    }
  }

  async stop(reason: CallEndReason): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pending?.resolve(null);
    this.pending = null;
    this.aiAudio = null;
    this.aiText = null;
    // the engine records the end of the run (customer gone / call over)
    if (this.state && this.state.status !== 'ended') {
      try {
        const r = await advance(
          this.deps.graph,
          this.state,
          {
            kind: 'hangup',
            reason: CALL_TO_RUN[reason] ?? 'customer_hangup',
            inputId: `end:${reason}`,
          },
          this.deps.effects,
          this.deps.ctx,
        );
        this.state = r.state;
        this.trace.push(...r.trace);
      } catch {
        // already ended
      }
    }
    await this.finish();
    await this.stt?.close();
  }

  result(): ScriptResult {
    const state = this.state;
    const o = state?.outcome;
    return {
      outcome: o ? { ...o } : {},
      disposition: o?.disposition ?? null,
      variables: state ? runValues(this.deps.graph, state) : {},
      flowRunId: this.flowRunId,
      aiSeconds: this.aiSeconds,
      languageDetected: this.language,
    };
  }

  private async step(input: FlowInputBody): Promise<AdvanceResult> {
    const id = `in${String((this.state?.inputs ?? 0) + 1)}:${input.kind}`;
    const result = await advance(
      this.deps.graph,
      this.state,
      { ...input, inputId: id },
      this.deps.effects,
      this.deps.ctx,
      input.kind === 'start' ? this.deps.contact : undefined,
      input.kind === 'start' ? this.deps.seed : undefined,
    );
    this.state = result.state;
    this.trace.push(...result.trace);
    for (const row of result.trace) {
      if (row.event === 'entered')
        this.io?.event('node_entered', { nodeId: row.nodeId, type: row.type });
      else if (row.event === 'exited')
        this.io?.event('node_exited', { nodeId: row.nodeId, handle: row.handle ?? null });
    }
    await this.deps.onStep?.(result);
    if (result.state.status === 'ended') await this.finish();
    return result;
  }

  private async finish(): Promise<void> {
    if (this.finished || !this.state) return;
    this.finished = true;
    this.flowRunId = (await this.deps.onFinish?.(this.state, this.trace)) ?? null;
  }

  private async perform(outputs: FlowOutput[]): Promise<void> {
    const io = this.io as CallIO;
    for (const out of outputs) {
      if (this.stopped) return;
      switch (out.type) {
        case 'say': {
          this.interruptible = out.interruptible;
          const language =
            out.language === 'auto' ? (this.language ?? this.deps.language) : out.language;
          const played = await io.say(out.text, {
            language,
            interruptible: out.interruptible,
            voice: out.voice || this.deps.voice,
          });
          this.interruptible = false;
          // a barged-in prompt: skip the rest of this batch up to the next listener
          if (!played.completed && (this.dtmf.length || this.speech.length)) return;
          break;
        }
        case 'ai_reply':
          await io.say(out.text, { source: 'ai', voice: this.deps.voice });
          break;
        case 'play': {
          const pcm = await this.deps.loadAudio(out.audioId);
          if (pcm) await io.play(pcm, out.audioName, 'audio');
          break;
        }
        default:
          break; // listeners are armed by the wait; notes / queued messages are in the run
      }
    }
  }

  /** Waits for the input the engine asked for. Resolves `null` when the call ended. */
  private inputFor(waiting: Waiting): Promise<FlowInputBody | null> {
    const io = this.io as CallIO;
    switch (waiting.kind) {
      case 'timer':
        return new Promise((resolve) => {
          this.pending = { resolve };
          io.clock.setTimeout(() => this.settle({ kind: 'timer' }), (waiting.seconds ?? 1) * 1000);
        });
      case 'transfer':
        io.event('transfer', { phoneLast4: waiting.transferPhoneLast4 ?? '' });
        return io.leg
          .transfer(waiting.transferPhoneLast4 ?? '', CALL_LIMITS.transferAnswerSec)
          .then((result) => (this.stopped ? null : { kind: 'transfer_result', result }));
      case 'ai':
        return this.runAiStep(waiting);
      case 'dtmf':
        return this.waitDtmf(waiting);
      case 'speech':
        return this.waitSpeech(waiting);
    }
  }

  private settle(input: FlowInputBody | null): void {
    const p = this.pending;
    this.pending = null;
    this.listening = null;
    p?.resolve(input);
  }

  /** New key / words arrived — wake whichever wait is listening. */
  private deliver(): void {
    const w = this.listening;
    if (!w || !this.pending) return;
    if (w.kind === 'speech' && this.speech.length) {
      const s = this.speech.shift() as { text: string };
      this.settle({ kind: 'speech', text: s.text });
    } else if (w.kind === 'dtmf') {
      this.collectDigits(w);
    }
  }

  private waitDtmf(waiting: Waiting): Promise<FlowInputBody | null> {
    const io = this.io as CallIO;
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.listening = waiting;
      // time is up: keys typed so far still count (the engine validates them)
      const timeout = io.clock.setTimeout(
        () => {
          this.clearDigitTimer();
          const typed = this.dtmf.splice(0).join('');
          this.settle(typed ? { kind: 'dtmf', digits: typed } : { kind: 'no_input' });
        },
        (waiting.timeoutSec ?? 7) * 1000,
      );
      const original = this.pending.resolve;
      this.pending.resolve = (input) => {
        io.clock.clearTimeout(timeout);
        original(input);
      };
      this.collectDigits(waiting);
    });
  }

  private collectDigits(waiting: Waiting): void {
    const io = this.io as CallIO;
    if (waiting.mode !== 'digits') {
      const key = this.dtmf.shift();
      if (key !== undefined) this.settle({ kind: 'dtmf', digits: key });
      return;
    }
    const finish = waiting.finishKey ?? '#';
    const max = waiting.maxDigits ?? 20;
    const end = this.dtmf.indexOf('#');
    if (finish === '#' && end !== -1) {
      const digits = this.dtmf
        .splice(0, end + 1)
        .slice(0, -1)
        .join('');
      this.clearDigitTimer();
      this.settle({ kind: 'dtmf', digits });
      return;
    }
    if (this.dtmf.length >= max) {
      this.clearDigitTimer();
      this.settle({ kind: 'dtmf', digits: this.dtmf.splice(0, max).join('') });
      return;
    }
    if (this.dtmf.length > 0) {
      this.clearDigitTimer();
      this.digitTimer = io.clock.setTimeout(() => {
        this.digitTimer = null;
        this.settle({ kind: 'dtmf', digits: this.dtmf.splice(0).join('') });
      }, CALL_LIMITS.digitsInterDigitSec * 1000);
    }
  }

  private clearDigitTimer(): void {
    if (this.digitTimer !== null) this.io?.clock.clearTimeout(this.digitTimer);
    this.digitTimer = null;
  }

  private waitSpeech(waiting: Waiting): Promise<FlowInputBody | null> {
    const io = this.io as CallIO;
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.listening = waiting;
      let timer: unknown = null;
      const arm = () => {
        if (timer !== null) io.clock.clearTimeout(timer);
        timer = io.clock.setTimeout(
          () => this.settle({ kind: 'no_input' }),
          (waiting.timeoutSec ?? 8) * 1000,
        );
      };
      // the customer started talking: give them the full time again
      this.wakeSpeech = arm;
      const original = this.pending.resolve;
      this.pending.resolve = (input) => {
        if (timer !== null) io.clock.clearTimeout(timer);
        this.wakeSpeech = null;
        original(input);
      };
      arm();
      this.deliver();
    });
  }

  private async runAiStep(waiting: Waiting): Promise<FlowInputBody | null> {
    const io = this.io as CallIO;
    const node = this.deps.graph.nodes.find((n) => n.id === waiting.nodeId);
    const state = this.state as FlowRunState;
    if (!node || node.type !== 'ai_agent') return { kind: 'no_input' };
    const started = io.clock.now();
    io.event('ai_session_started', { nodeId: node.id });
    const end = await this.deps.runAi({
      nodeId: node.id,
      config: node.config as NodeConfig<'ai_agent'>,
      values: runValues(this.deps.graph, state),
      turns: state.ai?.turns ?? [],
      io,
      inputs: {
        setAudio: (fn) => (this.aiAudio = fn),
        setText: (fn) => (this.aiText = fn),
      },
    });
    this.aiAudio = null;
    this.aiText = null;
    this.aiSeconds += Math.max(end.aiSeconds, (io.clock.now() - started) / 1000);
    this.language = end.language ?? this.language;
    io.event('ai_session_ended', { nodeId: node.id, reason: end.reason, turns: end.turns });
    if (this.stopped) return null;
    return { kind: 'ai_session_end', outcome: end.outcome, reason: end.reason, turns: end.turns };
  }
}
