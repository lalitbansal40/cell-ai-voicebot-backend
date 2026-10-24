import { afterEach, describe, expect, it } from 'vitest';

import { FakeWaUser } from '../../src/core/telephony/whatsapp/fake-user';
import { WhatsAppCallLeg } from '../../src/core/telephony/whatsapp/leg';
import { WhatsAppPeer, type ReceivedPacket } from '../../src/core/telephony/whatsapp/peer';
import { hasTone } from '../../src/core/telephony/whatsapp/tones';
import { tone } from '../../src/core/voice/audio/pcm';

const RATE = 24_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
};
const join = (parts: Int16Array[]) => {
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
};

interface Rig {
  leg: WhatsAppCallLeg;
  user: FakeWaUser;
  peer: WhatsAppPeer;
  heard: Int16Array[];
  terminates: number;
}
const rigs: Rig[] = [];

/**
 * Our leg ⇄ the fake customer on 127.0.0.1 (business-initiated shape: we offer,
 * the Meta-like ICE-lite side answers). `dropEvery` drops every Nth inbound packet.
 */
const rig = async (opts: { dropEvery?: number; mediaTimeoutMs?: number } = {}): Promise<Rig> => {
  const peer = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
  let n = 0;
  const lossy = opts.dropEvery
    ? Object.assign(Object.create(peer) as WhatsAppPeer, {
        onPacket: (fn: (p: ReceivedPacket) => void) => {
          peer.onPacket((p) => {
            n += 1;
            if (n % (opts.dropEvery ?? 1) !== 0) fn(p);
          });
        },
      })
    : peer;
  const r: Rig = { leg: null as never, user: new FakeWaUser(), peer, heard: [], terminates: 0 };
  r.leg = new WhatsAppCallLeg({
    peer: lossy,
    signaling: {
      terminate: () => {
        r.terminates += 1;
        return Promise.resolve();
      },
    },
    ...(opts.mediaTimeoutMs ? { mediaTimeoutMs: opts.mediaTimeoutMs } : {}),
  });
  r.leg.onAudio((f) => r.heard.push(f));
  const answer = await r.user.answer(await peer.createOffer());
  await peer.applyAnswer(answer);
  await Promise.all([peer.connected, r.user.connected]);
  rigs.push(r);
  return r;
};

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.leg.hangup('normal');
    await r.user.hangup();
  }
});

describe('WhatsAppCallLeg — media on loopback', () => {
  it('is a 24 kHz leg; tone both ways; setup metrics', async () => {
    const r = await rig();
    expect(r.leg.rate).toBe(24_000);
    r.leg.answered();
    r.user.startTalking();
    const result = await r.leg.play(tone(1_500, RATE, { hz: 1_000, amplitude: 8_000 }));
    expect(result.completed).toBe(true);
    expect(result.playedMs).toBe(1_500);
    expect(r.user.stats.heardTone).toBe(true);
    const all = join(r.heard);
    expect(r.heard.every((f) => f.length === 480)).toBe(true);
    expect(hasTone(all.subarray(all.length >> 1), RATE, 440, 1_000)).toBe(true);
    const m = r.leg.metrics;
    expect(m.setupMs).not.toBeNull();
    expect(m.packetsIn).toBeGreaterThan(50);
    expect(m.packetsOut).toBeGreaterThanOrEqual(75);
    expect(m.lossPct).toBe(0);
    expect(m.rttMs).toBeNull();
  });

  it('DTMF both ways (customer keys → onDtmf, agent keypad → customer)', async () => {
    const r = await rig();
    r.leg.answered();
    const digits: string[] = [];
    r.leg.onDtmf((d) => digits.push(d));
    await r.user.pressDigits('12#');
    await waitFor(() => digits.length === 3);
    expect(digits).toEqual(['1', '2', '#']);
    await r.leg.sendDigits('5*x');
    await waitFor(() => r.user.stats.dtmfHeard === '5*');
  });

  it('keeps media flowing in silence (5 s idle ≈ 250 frames)', async () => {
    const r = await rig();
    r.leg.answered();
    const before = r.user.stats.packetsIn;
    await sleep(5_000);
    expect(r.user.stats.packetsIn - before).toBeGreaterThan(235);
    expect(r.leg.playing).toBe(false);
  });

  it('barge-in: clearAudio stops outbound audio within one frame', async () => {
    const r = await rig();
    r.leg.answered();
    let outgoing = 0;
    r.leg.onOutgoing(() => {
      outgoing += 1;
    });
    const playing = r.leg.play(tone(3_000, RATE, { hz: 1_000 }));
    await sleep(500);
    const playedMs = r.leg.clearAudio();
    const at = outgoing;
    expect(playedMs).toBeGreaterThan(300);
    expect(playedMs).toBeLessThan(700);
    expect((await playing).completed).toBe(false);
    await sleep(60);
    expect(outgoing - at).toBeLessThanOrEqual(1);
    expect(r.leg.playing).toBe(false);
    // keep-alive continues after the barge-in
    const packets = r.user.stats.packetsIn;
    await sleep(200);
    expect(r.user.stats.packetsIn).toBeGreaterThan(packets + 5);
  });

  it('our hangup terminates at Meta once; Meta ending the call does not terminate back', async () => {
    const a = await rig();
    const statuses: string[] = [];
    a.leg.onStatus((s) => statuses.push(s));
    a.leg.ringing();
    a.leg.answered();
    a.leg.answered();
    await Promise.all([a.leg.hangup('normal'), a.leg.hangup('normal')]);
    expect(a.terminates).toBe(1);
    expect(statuses).toEqual(['ringing', 'answered']);
    expect(a.peer.pc.connectionState).toBe('closed');
    expect((await a.leg.play(new Int16Array(480))).completed).toBe(false);
    expect(await a.leg.transfer('1234', 10)).toBe('failed');

    const b = await rig();
    const ended: [string, string | undefined][] = [];
    b.leg.onStatus((s, cause) => ended.push([s, cause]));
    b.leg.answered();
    b.leg.remoteEnded('customer_hangup');
    b.leg.remoteEnded('customer_hangup');
    expect(ended).toEqual([
      ['answered', undefined],
      ['ended', 'customer_hangup'],
    ]);
    await b.leg.hangup('normal');
    expect(b.terminates).toBe(0);
  });

  it('no inbound media after the answer → media_timeout and a terminate', async () => {
    const r = await rig({ mediaTimeoutMs: 1_200 });
    const ended: (string | undefined)[] = [];
    r.leg.onStatus((s, cause) => s === 'ended' && ended.push(cause));
    r.leg.answered();
    // the customer never sends audio
    await waitFor(() => ended.length > 0, 4_000);
    expect(ended).toEqual(['media_timeout']);
    await waitFor(() => r.terminates === 1);
  });

  it('10 % packet loss: the tone is still heard, loss is measured and concealed', async () => {
    const r = await rig({ dropEvery: 10 });
    r.leg.answered();
    r.user.startTalking();
    await sleep(2_000);
    const all = join(r.heard);
    expect(hasTone(all.subarray(all.length >> 2), RATE, 440, 1_000)).toBe(true);
    const m = r.leg.metrics;
    expect(m.lossPct).toBeGreaterThan(5);
    expect(m.lossPct).toBeLessThan(15);
    // concealed frames keep the stream continuous (≈ 20 ms per frame)
    expect(r.heard.length).toBeGreaterThan(80);
  });

  it('transfer goes to the signalling transfer when given', async () => {
    const peer = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
    const leg = new WhatsAppCallLeg({
      peer,
      signaling: {
        terminate: () => Promise.resolve(),
        transfer: (last4, sec) =>
          Promise.resolve(last4 === '1234' && sec === 30 ? 'connected' : 'failed'),
      },
    });
    expect(await leg.transfer('1234', 30)).toBe('connected');
    leg.notify({ type: 'ignored' });
    leg.onText();
    await leg.hangup('normal');
  });

  it('10 legs in parallel', async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () => rig()));
    for (const r of all) {
      r.leg.answered();
      r.user.startTalking();
    }
    await Promise.all(all.map((r) => r.leg.play(tone(800, RATE, { hz: 1_000, amplitude: 8_000 }))));
    await sleep(200);
    for (const r of all) {
      expect(r.user.stats.heardTone).toBe(true);
      expect(r.heard.length).toBeGreaterThan(20);
    }
  });
});
