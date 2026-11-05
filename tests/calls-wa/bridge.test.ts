import { describe, expect, it, vi } from 'vitest';

import type { CallLeg } from '../../src/core/telephony/types';
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

it('bridges SIP 8 kHz and browser 24 kHz as paced 20 ms frames, and stops both directions on hold', async () => {
  const clock = new FakeClock();
  const customer = makeLeg(clock);
  const agent = makeLeg(clock);
  const customerPlay = vi
    .fn<CallLeg['play']>()
    .mockResolvedValue({ completed: true, playedMs: 20 });
  const agentPlay = vi
    .spyOn(agent.leg, 'play')
    .mockResolvedValue({ completed: true, playedMs: 20 });
  const sip = new Proxy(customer.leg, {
    get(target, name) {
      if (name === 'rate') return 8000;
      if (name === 'play') return customerPlay;
      const value: unknown = Reflect.get(target, name);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
  const bridge = new BridgeScript();
  const say = vi.fn().mockResolvedValue(undefined);
  bridge.attachAgent(agent.leg);
  const run = bridge.run({ leg: sip, clock, elapsedMs: () => 0, say } as unknown as CallIO);
  await clock.tick(1);
  for (let i = 0; i < 10; i += 1) {
    agent.leg.receiveAudio(new Int16Array(480).fill(1200));
    customer.leg.receiveAudio(new Int16Array(160).fill(800));
  }
  expect(customerPlay).toHaveBeenCalledTimes(9);
  expect(agentPlay).toHaveBeenCalledTimes(9);
  expect(customerPlay.mock.calls.every(([frame]) => frame.length === 160)).toBe(true);
  expect(agentPlay.mock.calls.every(([frame]) => frame.length === 480)).toBe(true);
  expect(customerPlay.mock.calls.at(-1)?.[0][80]).toBeCloseTo(1200, -1);
  expect(agentPlay.mock.calls.at(-1)?.[0][240]).toBeCloseTo(800, -1);
  await bridge.setHold(true);
  agent.leg.receiveAudio(new Int16Array(480));
  customer.leg.receiveAudio(new Int16Array(160));
  expect(customerPlay).toHaveBeenCalledTimes(9);
  expect(agentPlay).toHaveBeenCalledTimes(9);
  expect(say).toHaveBeenCalledOnce();
  await bridge.setHold(false);
  agent.leg.receiveAudio(new Int16Array(480));
  expect(customerPlay).toHaveBeenCalledTimes(10);
  await bridge.stop('agent_end_call');
  expect(await run).toBe('agent_end_call');
});
