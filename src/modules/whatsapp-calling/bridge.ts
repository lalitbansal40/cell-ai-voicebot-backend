import { CALL_LIMITS } from '../../config/limits';
import type { CallLeg } from '../../core/telephony/types';
import type { CallEndReason } from '../../db/models/call.model';
import type { CallIO, CallScript, ScriptResult } from '../calls/session';

/**
 * Human WhatsApp calls (PHASE_12_PROMPT T12.6): the agent's browser leg (`AgentLeg` =
 * the Phase 7 `WebCallLeg` on `/ws/media`, ticket bound to the agent + call) is
 * bridged to the WhatsApp leg through the server — straight pass-through both ways
 * (the session records both channels), the agent's keypad goes to the customer as
 * RFC 4733, hold plays a line to the customer and stops the audio both ways.
 */
export const HOLD_LINE =
  'Kripya line par bane rahein, aapki call hold par hai. / Please stay on the line.';

/** A leg that can send keys to the customer (the WhatsApp leg). */
interface KeypadLeg extends CallLeg {
  sendDigits?(digits: string): Promise<void>;
}

const emptyResult = (): ScriptResult => ({
  outcome: {},
  disposition: null,
  variables: {},
  flowRunId: null,
  aiSeconds: 0,
  languageDetected: null,
});

export class BridgeScript implements CallScript {
  private agent: CallLeg | null = null;
  private agentReady: Promise<CallLeg>;
  private resolveAgent: (leg: CallLeg) => void = () => undefined;
  private done: (reason: CallEndReason) => void = () => undefined;
  private held = false;
  private io: CallIO | null = null;
  private stopped = false;
  /** The agent left before / while the bridge started (e.g. during the recording notice). */
  private agentLeft = false;
  private reconnectTimer: unknown = null;

  constructor(private readonly options: { agentWaitSec?: number } = {}) {
    this.agentReady = new Promise((resolve) => {
      this.resolveAgent = resolve;
    });
  }

  /** The agent's socket arrived (`call.ready` already sent by the browser). */
  attachAgent(leg: CallLeg): void {
    if (this.agent || this.stopped) return;
    this.agent = leg;
    if (this.reconnectTimer !== null && this.io) this.io.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // listen at once: the agent may leave while the recording notice still plays
    leg.onStatus((status, cause) => {
      if (status !== 'ended' || this.agent !== leg || this.stopped) return;
      if (cause === 'media_error') {
        this.agent = null;
        this.agentReady = new Promise((resolve) => {
          this.resolveAgent = resolve;
        });
        if (this.io)
          this.reconnectTimer = this.io.clock.setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.agent) this.done('media_error');
          }, CALL_LIMITS.readyTimeoutSec * 1000);
        return;
      }
      this.agentLeft = true;
      this.done('agent_end_call');
    });
    leg.onAudio((frame) => {
      if (this.agent === leg && this.io && !this.held && !this.stopped)
        void this.io.leg.play(frame);
    });
    leg.onDtmf((digit) => {
      if (this.agent === leg && this.io && !this.stopped)
        void (this.io.leg as KeypadLeg).sendDigits?.(digit);
    });
    this.resolveAgent(leg);
  }

  get hasAgent(): boolean {
    return this.agent !== null;
  }

  get onHold(): boolean {
    return this.held;
  }

  /** Hold on: the customer hears the hold line, the agent / customer audio stops both ways. */
  async setHold(on: boolean): Promise<void> {
    if (this.held === on) return;
    this.held = on;
    this.agent?.notify({ type: 'call.hold', on });
    if (on && this.io) {
      this.io.leg.clearAudio();
      await this.io.say(HOLD_LINE, { interruptible: false, source: 'system' });
    }
  }

  async run(io: CallIO): Promise<CallEndReason | void> {
    this.io = io;
    const waitMs = (this.options.agentWaitSec ?? CALL_LIMITS.readyTimeoutSec) * 1000;
    const agent = await Promise.race([
      this.agentReady,
      new Promise<null>((resolve) => {
        io.clock.setTimeout(() => resolve(null), waitMs);
      }),
    ]);
    if (!agent || this.stopped) return 'no_agent_available';
    if (this.agentLeft) return 'agent_end_call';
    const customer = io.leg as KeypadLeg;
    return new Promise<CallEndReason>((resolve) => {
      this.done = resolve;
      // customer → agent
      customer.onAudio((frame) => {
        if (!this.held && !this.stopped) void this.agent?.play(frame);
      });
      // the agent hears a key the customer pressed (no digit in logs / events)
      customer.onDtmf(() => this.agent?.notify({ type: 'call.dtmf' }));
    });
  }

  async stop(reason: CallEndReason): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== null && this.io) this.io.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.done(reason);
    this.resolveAgent = () => undefined;
    await this.agent?.hangup('normal', {
      type: 'call.ended',
      reason,
      durationSec: Math.max(0, Math.round((this.io?.elapsedMs() ?? 0) / 1000)),
      costMicros: 0,
    });
  }

  result(): ScriptResult {
    return emptyResult();
  }
}
