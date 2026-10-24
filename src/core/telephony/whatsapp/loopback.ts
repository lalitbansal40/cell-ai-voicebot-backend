import { tone } from '../../voice/audio/pcm';

import { createOpusCodec, OPUS_FRAME_SAMPLES, OPUS_RATE } from './codec';
import { DtmfReceiver, dtmfPackets } from './dtmf';
import { DTMF_PT, OPUS_PT, WhatsAppPeer } from './peer';
import { createLegResamplers, LEG_RATE } from './resample';
import { hasTone } from './tones';

/**
 * PoC / test harness (ADR 0040): our business peer ⇄ a Meta-like ICE-lite peer
 * on 127.0.0.1. Proves setup, two-way Opus audio, RFC 4733 DTMF and silent
 * keep-alive, and measures setup time, CPU and memory. Dev / test only.
 */
export interface LoopbackOptions {
  toneMs?: number;
  silenceMs?: number;
  digits?: string;
}

export interface LoopbackResult {
  setupMs: number;
  businessHeardMeta: boolean;
  metaHeardBusiness: boolean;
  digitsReceived: string;
  /** Packets the business side received during the silent part (keep-alive). */
  silencePackets: number;
  stillConnected: boolean;
  /** Encode → network → decode of one packet, business → Meta (median, ms). */
  pipelineMs: number;
  /** Same, Meta → business (incl. the 48 → 24 kHz resampling). */
  pipelineBackMs: number;
  /** Mean change in transit time between consecutive packets (RFC 3550 style, ms). */
  jitterMs: number;
}

const FRAME_MS = 20;
const BUSINESS_HZ = 1_000;
const META_HZ = 440;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Sends `pcm48` (or silence) in 20 ms Opus packets, in real time. */
const streamAudio = async (
  peer: WhatsAppPeer,
  encode: (pcm: Int16Array) => Buffer,
  ms: number,
  pcm48: Int16Array | null,
  sentAt?: Map<number, number>,
): Promise<void> => {
  const frames = Math.round(ms / FRAME_MS);
  const start = performance.now();
  for (let i = 0; i < frames; i += 1) {
    const frame = pcm48
      ? pcm48.subarray(i * OPUS_FRAME_SAMPLES, (i + 1) * OPUS_FRAME_SAMPLES)
      : new Int16Array(OPUS_FRAME_SAMPLES);
    const full = frame.length === OPUS_FRAME_SAMPLES ? frame : new Int16Array(OPUS_FRAME_SAMPLES);
    const ts = peer.sendPacket(OPUS_PT, encode(full), { samples: OPUS_FRAME_SAMPLES });
    sentAt?.set(ts, performance.now());
    const due = start + (i + 1) * FRAME_MS;
    await sleep(Math.max(0, due - performance.now()));
  }
};

export const runLoopbackCall = async (options: LoopbackOptions = {}): Promise<LoopbackResult> => {
  const toneMs = options.toneMs ?? 2_000;
  const silenceMs = options.silenceMs ?? 3_000;
  const digits = options.digits ?? '123';
  const business = new WhatsAppPeer({ role: 'business', bindAddress: '127.0.0.1' });
  const meta = new WhatsAppPeer({ role: 'meta', bindAddress: '127.0.0.1' });
  const bizCodec = createOpusCodec();
  const metaCodec = createOpusCodec();
  const { down } = createLegResamplers();
  const heardByBusiness: Int16Array[] = [];
  const heardByMeta: Int16Array[] = [];
  let digitsReceived = '';
  const dtmf = new DtmfReceiver((d) => {
    digitsReceived += d;
  });
  let counting = false;
  let silencePackets = 0;
  const sentAt = new Map<number, number>();
  const sentBackAt = new Map<number, number>();
  const pipeline: number[] = [];
  const pipelineBack: number[] = [];

  business.onPacket((p) => {
    if (p.payloadType === DTMF_PT) {
      dtmf.push(p.payload, p.timestamp);
      return;
    }
    if (p.payloadType !== OPUS_PT) return;
    if (counting) silencePackets += 1;
    heardByBusiness.push(down.process(bizCodec.decode(p.payload)));
    const t0 = sentBackAt.get(p.timestamp);
    if (t0 !== undefined) pipelineBack.push(performance.now() - t0);
  });
  meta.onPacket((p) => {
    if (p.payloadType !== OPUS_PT) return;
    const decoded = metaCodec.decode(p.payload);
    const t0 = sentAt.get(p.timestamp);
    if (t0 !== undefined) pipeline.push(performance.now() - t0);
    heardByMeta.push(decoded);
  });

  try {
    const t0 = performance.now();
    const offer = await business.createOffer();
    const answer = await meta.answer(offer);
    await business.applyAnswer(answer);
    await Promise.all([business.connected, meta.connected]);
    const setupMs = performance.now() - t0;

    const bizTone = tone(toneMs, OPUS_RATE, { hz: BUSINESS_HZ, amplitude: 8_000 });
    const metaTone = tone(toneMs, OPUS_RATE, { hz: META_HZ, amplitude: 8_000 });
    await Promise.all([
      streamAudio(business, (f) => bizCodec.encode(f), toneMs, bizTone, sentAt),
      streamAudio(meta, (f) => metaCodec.encode(f), toneMs, metaTone, sentBackAt),
    ]);

    for (const digit of digits) {
      const start = meta.rtpTimestamp;
      const packets = dtmfPackets(digit);
      for (const [i, payload] of packets.entries()) {
        meta.sendPacket(DTMF_PT, payload, { samples: 0, marker: i === 0, timestamp: start });
        await sleep(FRAME_MS);
      }
      meta.advance(OPUS_FRAME_SAMPLES * packets.length);
      await sleep(60);
    }

    counting = true;
    await Promise.all([
      streamAudio(business, (f) => bizCodec.encode(f), silenceMs, null),
      streamAudio(meta, (f) => metaCodec.encode(f), silenceMs, null),
    ]);
    counting = false;
    await sleep(100);

    const joined = (parts: Int16Array[]) => {
      // the middle of the tone part (skip codec warm-up and the tail)
      const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      return all;
    };
    const biz = joined(heardByBusiness);
    const met = joined(heardByMeta);
    const windowOf = (pcm: Int16Array, rate: number) =>
      pcm.subarray(
        Math.floor(rate * 0.3),
        Math.floor((rate * toneMs) / 1000) - Math.floor(rate * 0.1),
      );
    let jitter = 0;
    for (let i = 1; i < pipeline.length; i += 1) {
      jitter += Math.abs((pipeline[i] ?? 0) - (pipeline[i - 1] ?? 0));
    }
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
    return {
      setupMs,
      businessHeardMeta: hasTone(windowOf(biz, LEG_RATE), LEG_RATE, META_HZ, BUSINESS_HZ),
      metaHeardBusiness: hasTone(windowOf(met, OPUS_RATE), OPUS_RATE, BUSINESS_HZ, META_HZ),
      digitsReceived,
      silencePackets,
      stillConnected: business.pc.connectionState === 'connected',
      pipelineMs: median(pipeline),
      pipelineBackMs: median(pipelineBack),
      jitterMs: pipeline.length > 1 ? jitter / (pipeline.length - 1) : 0,
    };
  } finally {
    bizCodec.destroy();
    metaCodec.destroy();
    await Promise.all([business.close(), meta.close()]);
  }
};
