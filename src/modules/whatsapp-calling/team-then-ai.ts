import type { CallEndReason } from '../../db/models/call.model';
import type { CallIO, CallScript, ScriptResult } from '../calls/session';

import type { BridgeScript } from './bridge';

/**
 * CM — WhatsApp route `team_then_ai`: the call is answered either by a team member (the
 * bridge) or, when nobody took it in time, by the number's AI program. Which one is decided
 * before the call is answered (`useAi()`), so `run` only follows that choice.
 */
export class TeamThenAiScript implements CallScript {
  private ai = false;
  private stopped = false;

  constructor(
    private readonly bridge: BridgeScript,
    private readonly fallback: CallScript,
  ) {}

  /** Nobody in the team took the call: the AI answers. */
  useAi(): void {
    this.ai = true;
  }

  get aiAnswers(): boolean {
    return this.ai;
  }

  run(io: CallIO): Promise<CallEndReason | void> {
    if (this.stopped) return Promise.resolve();
    return this.ai ? this.fallback.run(io) : this.bridge.run(io);
  }

  async stop(reason: CallEndReason): Promise<void> {
    this.stopped = true;
    await (this.ai ? this.fallback.stop(reason) : this.bridge.stop(reason));
  }

  result(): ScriptResult {
    return this.ai
      ? this.fallback.result()
      : {
          outcome: {},
          disposition: null,
          variables: {},
          flowRunId: null,
          aiSeconds: 0,
          languageDetected: null,
        };
  }
}
