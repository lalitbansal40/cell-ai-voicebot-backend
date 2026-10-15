import { describe, expect, it } from 'vitest';

import { WebCallLeg, type MediaChannel } from '../../src/core/telephony/webcall';
import { FakeClock } from '../../src/core/voice/clock';

const channel = () => {
  const json: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  const closed: [number, string][] = [];
  let buffered = 0;
  const ch: MediaChannel = {
    sendJson: (m) => json.push(m),
    sendBinary: (f) => binary.push(f),
    bufferedAmount: () => buffered,
    close: (code, reason) => closed.push([code, reason]),
  };
  return { ch, json, binary, closed, setBuffered: (n: number) => (buffered = n) };
};

describe('WebCallLeg', () => {
  it('plays clips as paced 960-byte frames; backpressure waits; clear flushes the browser', async () => {
    const clock = new FakeClock();
    const c = channel();
    const leg = new WebCallLeg(c.ch, clock);
    expect(leg.rate).toBe(24000);
    const started: string[] = [];
    const done = leg.play(new Int16Array(480 * 3 + 10).fill(5), () => started.push('x'));
    expect(c.binary).toHaveLength(1);
    expect(c.binary[0]?.length).toBe(960);
    expect(leg.playing).toBe(true);
    c.setBuffered(70_000);
    clock.advance(40);
    expect(c.binary).toHaveLength(1);
    c.setBuffered(0);
    clock.advance(60);
    expect(await done).toEqual({ completed: true, playedMs: 80 });
    expect(started).toEqual(['x']);
    // the congested socket held frames back; the stats say so
    expect(leg.pacerStats.stalledFrames).toBeGreaterThan(0);
    expect(leg.pacerStats.lateTicks).toBeGreaterThanOrEqual(0);
    void leg.play(new Int16Array(480 * 5));
    clock.advance(20);
    expect(leg.clearAudio()).toBe(40);
    expect(c.json.at(-1)).toEqual({ type: 'audio.clear' });
  });

  it('routes control messages, mutes audio and reports the end once', () => {
    const c = channel();
    const leg = new WebCallLeg(c.ch, new FakeClock());
    const seen: string[] = [];
    leg.onAudio((f) => seen.push(`audio:${String(f[0])}`));
    leg.onDtmf((d) => seen.push(`dtmf:${d}`));
    leg.onText((t) => seen.push(`text:${t}`));
    leg.onStatus((s, cause) => seen.push(`status:${s}:${String(cause)}`));
    leg.ringing();
    leg.receiveControl({ type: 'call.ready', sampleRate: 24000 });
    leg.receiveAudio(Int16Array.from([7]));
    leg.receiveControl({ type: 'call.mute', muted: true });
    leg.receiveAudio(Int16Array.from([7]));
    leg.receiveControl({ type: 'call.dtmf', digit: '1' });
    leg.receiveControl({ type: 'call.say_text', text: 'haan' });
    leg.receiveControl({ type: 'call.transfer_result', result: 'connected' }); // nothing pending
    leg.receiveControl({ type: 'call.hangup' });
    leg.receiveControl({ type: 'call.dtmf', digit: '2' });
    leg.receiveAudio(Int16Array.from([7]));
    leg.socketClosed();
    expect(seen).toEqual([
      'status:ringing:undefined',
      'status:answered:undefined',
      'audio:7',
      'audio:0',
      'dtmf:1',
      'text:haan',
      'status:ended:customer_hangup',
    ]);
  });

  it('transfer asks the tester and resolves on the answer or the timeout; hangup closes the socket', async () => {
    const clock = new FakeClock();
    const c = channel();
    const leg = new WebCallLeg(c.ch, clock);
    const answered = leg.transfer('0000', 60);
    expect(c.json.at(-1)).toEqual({ type: 'call.transfer', phoneLast4: '0000' });
    leg.receiveControl({ type: 'call.transfer_result', result: 'connected' });
    expect(await answered).toBe('connected');
    const timeout = leg.transfer('0000', 60);
    clock.advance(60_000);
    expect(await timeout).toBe('no_answer');
    const pending = leg.transfer('0000', 60);
    await leg.hangup('server_shutdown', { type: 'call.ended', reason: 'server_shutdown' });
    expect(await pending).toBe('failed');
    expect(c.json.at(-1)).toEqual({ type: 'call.ended', reason: 'server_shutdown' });
    expect(c.closed).toEqual([[1001, 'server_shutdown']]);
    await leg.hangup('normal');
    leg.notify({ type: 'late' });
    expect(c.closed).toHaveLength(1);
    expect(c.json.at(-1)).toEqual({ type: 'call.ended', reason: 'server_shutdown' });
    const other = new WebCallLeg(channel().ch, clock);
    const t = other.transfer('1', 60);
    other.socketClosed('media_error');
    expect(await t).toBe('failed');
    const c2 = channel();
    const third = new WebCallLeg(c2.ch, clock);
    await third.hangup('media_error');
    expect(c2.closed).toEqual([[1011, 'media_error']]);
  });

  it('regression: after the tester hangs up, the browser still gets call.ended and a close', async () => {
    const c = channel();
    const leg = new WebCallLeg(c.ch, new FakeClock());
    leg.receiveControl({ type: 'call.ready', sampleRate: 24000 });
    leg.receiveControl({ type: 'call.hangup' });
    leg.notify({ type: 'call.transcript' }); // nothing more after the end…
    await leg.hangup('customer_hangup', { type: 'call.ended', reason: 'customer_hangup' });
    // …except the final notice and the close (the tester was left waiting before)
    expect(c.json).toEqual([{ type: 'call.ended', reason: 'customer_hangup' }]);
    expect(c.closed).toEqual([[1000, 'customer_hangup']]);
    // a socket the browser closed is not written to
    const gone = channel();
    const dropped = new WebCallLeg(gone.ch, new FakeClock());
    dropped.socketClosed();
    await dropped.hangup('customer_hangup', { type: 'call.ended' });
    expect(gone.json).toEqual([]);
    expect(gone.closed).toEqual([]);
  });
});
