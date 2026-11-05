import { tone } from '../../../core/voice/audio/pcm';
import type { CallCost, CallEndReason } from '../../../db/models/call.model';
import type { BridgeScript } from '../../whatsapp-calling/bridge';
import type { CallBillingPort } from '../billing';
import type { CallIO, CallScript, ScriptResult } from '../session';

/** Programs of incoming phone calls (Phase 20) besides the flow / AI agent itself. */

const emptyResult = (): ScriptResult => ({
  outcome: {},
  disposition: null,
  variables: {},
  flowRunId: null,
  aiSeconds: 0,
  languageDetected: null,
});

/** Says one fixed line (after hours, wallet low, nobody free) and ends the call. */
export class MessageScript implements CallScript {
  constructor(
    private readonly text: string,
    private readonly reason: CallEndReason,
  ) {}

  async run(io: CallIO): Promise<CallEndReason> {
    await io.say(this.text, { interruptible: false, source: 'system' });
    return this.reason;
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  result(): ScriptResult {
    return { ...emptyResult(), disposition: 'message_played' };
  }
}

/** A call that must never cost the account anything (fixed lines when the wallet is low). */
export class FreeBilling implements CallBillingPort {
  readonly holdId = null;

  needsExtension(): boolean {
    return false;
  }

  extend(): Promise<boolean> {
    return Promise.resolve(true);
  }

  settle(): Promise<{ ledgerEntryId: string | null; cost: CallCost }> {
    return Promise.resolve({
      ledgerEntryId: null,
      cost: { telephonyMicros: 0, aiMicros: 0, ttsMicros: 0, commissionMicros: 0, totalMicros: 0 },
    });
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}

/** Indian ringback (400 Hz: 0.4 s on, 0.2 s off, 0.4 s on, 2 s off) at the leg rate. */
export const ringbackCycle = (rate: number): Int16Array => {
  const on = tone(400, rate, { hz: 400, amplitude: 2600 });
  const gap = new Int16Array(Math.round(rate * 0.2));
  const rest = new Int16Array(rate * 2);
  const out = new Int16Array(on.length * 2 + gap.length + rest.length);
  out.set(on, 0);
  out.set(gap, on.length);
  out.set(on, on.length + gap.length);
  out.set(rest, on.length * 2 + gap.length);
  return out;
};

/** What decided a team ring: a person took it, or nobody did (→ AI fallback / message). */
export type RingOutcome = 'agent' | 'none';

/**
 * The team route of an incoming call (D8, D19). Answered before a person takes it only
 * when the number has a greeting: then the caller hears it and ringback until the ring
 * ends. A person → the bridge; nobody → the AI program (`team_then_ai`) or the
 * "nobody free" line.
 */
export class TeamScript implements CallScript {
  private stopped = false;
  private active: CallScript | null = null;

  constructor(
    private readonly options: {
      greeting: string;
      bridge: BridgeScript;
      /** Resolves when the ring is over (it may already be over when the call is answered). */
      ring: Promise<RingOutcome>;
      fallback: CallScript | null;
      noAgentLine: string;
      /** Called when the fallback AI takes the call (it is no longer a missed call). */
      onFallback: () => void;
    },
  ) {}

  async run(io: CallIO): Promise<CallEndReason | void> {
    const { greeting, bridge, ring } = this.options;
    const state: { outcome: RingOutcome | null } = { outcome: null };
    void ring.then((o) => {
      state.outcome = o;
    });
    // settle an already-finished ring before deciding to play anything
    await Promise.resolve();
    if (state.outcome === null && greeting) {
      await io.say(greeting, { interruptible: false, source: 'system' });
    }
    const cycle = ringbackCycle(io.leg.rate);
    while (state.outcome === null && !this.stopped && !io.ended) {
      await Promise.race([io.leg.play(cycle), ring]);
    }
    io.leg.clearAudio();
    if (this.stopped || io.ended) return;
    if (state.outcome === 'agent') {
      this.active = bridge;
      return bridge.run(io);
    }
    const fallback = this.options.fallback;
    if (fallback) {
      this.options.onFallback();
      this.active = fallback;
      return fallback.run(io);
    }
    await io.say(this.options.noAgentLine, { interruptible: false, source: 'system' });
    return 'no_agent_available';
  }

  async stop(reason: CallEndReason): Promise<void> {
    this.stopped = true;
    await this.active?.stop(reason);
    if (this.active !== this.options.bridge) await this.options.bridge.stop(reason);
  }

  result(): ScriptResult {
    return this.active?.result() ?? emptyResult();
  }
}
