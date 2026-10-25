import type { CallEndReason } from '../../db/models/call.model';
import type { CallIO, CallScript, ScriptResult } from '../calls/session';

import type { BridgeScript } from './bridge';

/** Keeps the same call session and recording when an AI program hands over to an agent. */
export class HandoffScript implements CallScript {
  private bridge: BridgeScript | null = null;
  private stopped = false;
  private initialResult: ScriptResult | null = null;

  constructor(private readonly initial: CallScript) {}

  async takeOver(bridge: BridgeScript): Promise<void> {
    if (this.stopped) return;
    this.bridge = bridge;
    await this.initial.stop('transferred');
  }

  async run(io: CallIO): Promise<CallEndReason | void> {
    const reason = await this.initial.run(io);
    this.initialResult = this.initial.result();
    if (this.bridge && !this.stopped) return this.bridge.run(io);
    return reason;
  }

  async stop(reason: CallEndReason): Promise<void> {
    this.stopped = true;
    await this.initial.stop(reason);
    await this.bridge?.stop(reason);
  }

  result(): ScriptResult {
    return this.initialResult ?? this.initial.result();
  }
}
