import { describe, expect, it, vi } from 'vitest';

import type { CallIO, CallScript, ScriptResult } from '../../src/modules/calls/session';
import type { BridgeScript } from '../../src/modules/whatsapp-calling/bridge';
import { HandoffScript } from '../../src/modules/whatsapp-calling/handoff';

const result: ScriptResult = {
  outcome: { paid: true },
  disposition: 'Paid',
  variables: {},
  flowRunId: null,
  aiSeconds: 12,
  languageDetected: 'hi',
};
const io = {} as CallIO;
const script = () =>
  ({
    run: vi.fn().mockResolvedValue('transferred'),
    stop: vi.fn().mockResolvedValue(undefined),
    result: () => result,
  }) satisfies CallScript;

describe('AI to agent handoff', () => {
  it('continues on the bridge and retains the AI outcome and billable AI seconds', async () => {
    const ai = script();
    const handoff = new HandoffScript(ai);
    expect(handoff.result()).toBe(result);
    const human = script();
    await handoff.takeOver(human as unknown as BridgeScript);
    expect(ai.stop).toHaveBeenCalledWith('transferred');
    await handoff.run(io);
    expect(human.run).toHaveBeenCalledWith(io);
    expect(handoff.result()).toBe(result);
    await handoff.stop('customer_hangup');
    expect(human.stop).toHaveBeenCalledWith('customer_hangup');
  });

  it('finishes normally without a bridge and never starts a bridge after hangup', async () => {
    const handoff = new HandoffScript(script());
    expect(await handoff.run(io)).toBe('transferred');
    await handoff.stop('customer_hangup');
    const human = script();
    await handoff.takeOver(human as unknown as BridgeScript);
    await handoff.run(io);
    expect(human.run).not.toHaveBeenCalled();
    const stopped = new HandoffScript(script());
    await stopped.takeOver(human as unknown as BridgeScript);
    await stopped.stop('server_shutdown');
    await stopped.run(io);
    expect(human.run).not.toHaveBeenCalled();
  });
});
