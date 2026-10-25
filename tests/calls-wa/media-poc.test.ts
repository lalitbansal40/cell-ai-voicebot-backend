import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createOpusCodec,
  OPUS_FRAME_SAMPLES,
  OPUS_RATE,
} from '../../src/core/telephony/whatsapp/codec';
import {
  decodeDtmf,
  DtmfReceiver,
  dtmfPackets,
  encodeDtmf,
} from '../../src/core/telephony/whatsapp/dtmf';
import { runLoopbackCall } from '../../src/core/telephony/whatsapp/loopback';
import { DTMF_PT, OPUS_PT, WhatsAppPeer } from '../../src/core/telephony/whatsapp/peer';
import { createLegResamplers, LEG_RATE } from '../../src/core/telephony/whatsapp/resample';
import { describeSdp, scrubSdp, withPtime } from '../../src/core/telephony/whatsapp/sdp';
import { hasTone, tonePower } from '../../src/core/telephony/whatsapp/tones';
import { tone } from '../../src/core/voice/audio/pcm';
import { expectNoUdpHandles } from '../helpers/udp';

const frames = (pcm: Int16Array, size: number): Int16Array[] => {
  const out: Int16Array[] = [];
  for (let i = 0; i + size <= pcm.length; i += size) out.push(pcm.subarray(i, i + size));
  return out;
};
afterEach(expectNoUdpHandles);
const join = (parts: Int16Array[]): Int16Array => {
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
};

describe('Opus codec (opusscript)', () => {
  it('round-trips a tone in 20 ms frames and keeps its frequency', () => {
    const codec = createOpusCodec();
    const input = tone(1_000, OPUS_RATE, { hz: 1_000, amplitude: 8_000 });
    const decoded = join(
      frames(input, OPUS_FRAME_SAMPLES).map((f) => codec.decode(codec.encode(f))),
    );
    expect(decoded).toHaveLength(input.length);
    const mid = decoded.subarray(OPUS_RATE * 0.2, OPUS_RATE * 0.8);
    expect(hasTone(mid, OPUS_RATE, 1_000, 440)).toBe(true);
    // an empty packet (lost / DTX) is one frame of silence
    expect(codec.decode(Buffer.alloc(0))).toHaveLength(OPUS_FRAME_SAMPLES);
    codec.destroy();
    codec.destroy();
  });

  it('refuses frames of the wrong size', () => {
    const codec = createOpusCodec();
    expect(() => codec.encode(new Int16Array(100))).toThrow(RangeError);
    codec.destroy();
  });
});

describe('48 ⇄ 24 kHz resampling for the leg', () => {
  it('keeps tones (frequency, level) through down and up', () => {
    const { down, up } = createLegResamplers();
    const at48 = tone(1_000, OPUS_RATE, { hz: 440, amplitude: 8_000 });
    const at24 = join(frames(at48, OPUS_FRAME_SAMPLES).map((f) => down.process(f)));
    const mid24 = at24.subarray(LEG_RATE * 0.2, LEG_RATE * 0.8);
    expect(hasTone(mid24, LEG_RATE, 440, 1_000)).toBe(true);
    const back = join(frames(at24, 480).map((f) => up.process(f)));
    const mid48 = back.subarray(OPUS_RATE * 0.2, OPUS_RATE * 0.7);
    expect(hasTone(mid48, OPUS_RATE, 440, 1_000)).toBe(true);
    // level within ± 1 dB
    const ratio =
      tonePower(mid48, OPUS_RATE, 440) /
      tonePower(at48.subarray(OPUS_RATE * 0.2, OPUS_RATE * 0.7), OPUS_RATE, 440);
    expect(10 * Math.log10(ratio)).toBeGreaterThan(-1);
    expect(10 * Math.log10(ratio)).toBeLessThan(1);
  });

  it('keeps the frequency within 1 % and has no clicks at frame joins', () => {
    const { down } = createLegResamplers();
    for (const hz of [440, 1_000]) {
      const at48 = tone(1_000, OPUS_RATE, { hz, amplitude: 8_000 });
      const at24 = join(frames(at48, OPUS_FRAME_SAMPLES).map((f) => down.process(f)));
      const mid = at24.subarray(LEG_RATE * 0.2, LEG_RATE * 0.8);
      let crossings = 0;
      for (let i = 1; i < mid.length; i += 1) {
        if ((mid[i - 1] ?? 0) < 0 && (mid[i] ?? 0) >= 0) crossings += 1;
      }
      const measured = crossings / (mid.length / LEG_RATE);
      expect(Math.abs(measured - hz) / hz).toBeLessThan(0.01);
      // the steepest step of a clean sine is 2π·f·A / rate; a click at a join would exceed it
      const maxStep = (2 * Math.PI * hz * 8_000) / LEG_RATE;
      let worst = 0;
      for (let i = 1; i < mid.length; i += 1) {
        worst = Math.max(worst, Math.abs((mid[i] ?? 0) - (mid[i - 1] ?? 0)));
      }
      expect(worst).toBeLessThan(maxStep * 1.1);
    }
  });
});

describe('RFC 4733 DTMF', () => {
  it('encodes / decodes events, packets end with three end-bit packets', () => {
    expect(decodeDtmf(encodeDtmf('#', 800, true))).toEqual({
      digit: '#',
      end: true,
      duration: 800,
    });
    expect(decodeDtmf(encodeDtmf('0', 160, false))).toEqual({
      digit: '0',
      end: false,
      duration: 160,
    });
    expect(() => encodeDtmf('A', 1, false)).toThrow(RangeError);
    expect(decodeDtmf(Buffer.alloc(2))).toBeNull();
    expect(decodeDtmf(Buffer.from([20, 0, 0, 0]))).toBeNull();
    const packets = dtmfPackets('5', 100);
    expect(packets.slice(-3).every((p) => decodeDtmf(p)?.end)).toBe(true);
    expect(packets.slice(0, -3).every((p) => decodeDtmf(p)?.end === false)).toBe(true);
    expect(decodeDtmf(encodeDtmf('9', 0x1_0000, true))?.duration).toBe(0xffff);
  });

  it('the receiver reports each digit once per timestamp', () => {
    const got: string[] = [];
    const rx = new DtmfReceiver((d) => got.push(d));
    for (const p of dtmfPackets('1')) rx.push(p, 1000);
    for (const p of dtmfPackets('2')) rx.push(p, 2000);
    for (const p of dtmfPackets('2')) rx.push(p, 3000);
    expect(got).toEqual(['1', '2', '2']);
  });
});

describe('tone detection', () => {
  it('finds the dominant tone, not silence or the other one', () => {
    const t = tone(200, LEG_RATE, { hz: 1_000, amplitude: 8_000 });
    expect(hasTone(t, LEG_RATE, 1_000, 440)).toBe(true);
    expect(hasTone(t, LEG_RATE, 440, 1_000)).toBe(false);
    expect(hasTone(new Int16Array(4_800), LEG_RATE, 1_000, 440)).toBe(false);
    expect(tonePower(new Int16Array(0), LEG_RATE, 1_000)).toBe(0);
  });
});

const metaAnswer = readFileSync(
  joinPath(__dirname, '../fixtures/meta/calls-sdp-answer.txt'),
  'utf8',
);

describe('SDP shape (Meta reference answer)', () => {
  it('reads the documented Meta answer: ICE-lite, DTLS active, Opus + telephone-event, one SSRC', () => {
    const s = describeSdp(metaAnswer);
    expect(s).toMatchObject({
      iceLite: true,
      setup: 'active',
      rtcpMux: true,
      bundle: true,
      audioSections: 1,
      ssrcCount: 1,
      candidateCount: 1,
      hasFingerprint: true,
      hasIceCredentials: true,
    });
    expect(s.codecs).toEqual([
      { payloadType: OPUS_PT, name: 'opus', clockRate: 48_000, channels: 2 },
      { payloadType: DTMF_PT, name: 'telephone-event', clockRate: 8_000, channels: null },
    ]);
  });

  it('our offer and the fake Meta answer have the same shape as Meta', async () => {
    const business = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
    const meta = new WhatsAppPeer({ role: 'meta', bindAddress: '127.0.0.1' });
    try {
      const offer = await business.createOffer();
      const answer = await meta.answer(offer);
      const o = describeSdp(offer);
      expect(o).toMatchObject({
        iceLite: false,
        setup: 'actpass',
        rtcpMux: true,
        bundle: true,
        ssrcCount: 1,
      });
      expect(o.codecs).toEqual(describeSdp(metaAnswer).codecs);
      expect(offer).toMatch(/^a=ptime:20$/m);
      const a = describeSdp(answer);
      const ref = describeSdp(metaAnswer);
      expect({ ...a, candidateCount: ref.candidateCount }).toEqual(ref);
    } finally {
      await Promise.all([business.close(), meta.close()]);
    }
    expect(business.pc.signalingState).toBe('closed');
    expect(meta.pc.signalingState).toBe('closed');
  });

  it('scrubs SDP for logs and adds ptime once', () => {
    const scrubbed = scrubSdp(metaAnswer);
    expect(scrubbed).toBe(
      'sdp(audio=1 codecs=opus/48000,telephone-event/8000 setup=active lite=true candidates=1)',
    );
    for (const secret of ['testufrag', 'testpassword', '203.0.113.10', '00:11:22', 'testcname']) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(withPtime(metaAnswer)).toBe(metaAnswer);
    const without = metaAnswer.replace('a=ptime:20\r\n', '');
    expect(withPtime(without)).toBe(metaAnswer);
  });
});

describe('loopback call with a Meta-like ICE-lite peer (real UDP on 127.0.0.1)', () => {
  it('connects, carries audio both ways and DTMF, and keeps the session alive in silence', async () => {
    const r = await runLoopbackCall({ toneMs: 2_000, silenceMs: 5_000, digits: '123' });
    expect(r.businessHeardMeta).toBe(true);
    expect(r.metaHeardBusiness).toBe(true);
    expect(r.digitsReceived).toBe('123');
    // 5 s of silence = 250 frames; allow a few in flight
    expect(r.silencePackets).toBeGreaterThan(240);
    expect(r.stillConnected).toBe(true);
    expect(r.setupMs).toBeLessThan(3_000);
  });
});
