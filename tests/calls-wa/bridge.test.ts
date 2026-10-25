import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../src/core/voice/clock';
import type { CallIO } from '../../src/modules/calls/session';
import { BridgeScript } from '../../src/modules/whatsapp-calling/bridge';
import { makeLeg } from '../helpers/calls';

describe('WhatsApp agent media reconnect', () => {
  it('replaces a dropped browser leg, keeps two-way media, and still ends on an explicit hangup', async () => {
    const clock = new FakeClock();
    const customer = makeLeg(clock);
    const first = makeLeg(clock);
    const next = makeLeg(clock);
    const bridge = new BridgeScript();
    bridge.attachAgent(first.leg);
    const run = bridge.run({
      leg: customer.leg,
      clock,
      elapsedMs: () => 7_000,
      say: vi.fn(),
    } as unknown as CallIO);
    await clock.tick(1);
    try {
      first.leg.socketClosed('media_error');
      expect(bridge.hasAgent).toBe(false);
      bridge.attachAgent(next.leg);
      expect(bridge.hasAgent).toBe(true);
      customer.leg.receiveAudio(new Int16Array(480).fill(100));
      next.leg.receiveAudio(new Int16Array(480).fill(200));
      await clock.tick(40);
      expect(next.binary.length).toBeGreaterThan(0);
      expect(customer.binary.length).toBeGreaterThan(0);
      next.leg.receiveControl({ type: 'call.hangup' });
      expect(await run).toBe('agent_end_call');
    } finally {
      await bridge.stop('customer_hangup');
    }
  });

  it('ends a dropped call when its reconnect grace expires', async () => {
    const clock = new FakeClock();
    const customer = makeLeg(clock);
    const agent = makeLeg(clock);
    const bridge = new BridgeScript();
    bridge.attachAgent(agent.leg);
    const run = bridge.run({
      leg: customer.leg,
      clock,
      elapsedMs: () => 0,
      say: vi.fn(),
    } as unknown as CallIO);
    await clock.tick(1);
    agent.leg.socketClosed('media_error');
    await clock.tick(15_001);
    expect(await run).toBe('media_error');
    await bridge.stop('media_error');
  });
});
