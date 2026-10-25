import { CALL_LIMITS, WHATSAPP_CALL_LIMITS } from '../../../config/limits';
import { Framer } from '../../voice/audio/framer';
import { Pacer, type PlaybackResult } from '../../voice/audio/pacer';
import { systemClock, type Clock } from '../../voice/clock';
import type { CallLeg, HangupCause, LegNotice, LegStatus, TransferResult } from '../types';

import { createOpusCodec, OPUS_FRAME_SAMPLES, type OpusCodec } from './codec';
import { DtmfReceiver, dtmfPackets, DTMF_DIGITS } from './dtmf';
import { DTMF_PT, OPUS_PT, type ReceivedPacket, type WhatsAppPeer } from './peer';
import { createLegResamplers, LEG_RATE } from './resample';

/**
 * One WhatsApp call as a Phase 7 `CallLeg` (PHASE_12_PLAN §1h, ADR 0040).
 * Inbound: RTP → small reorder buffer → Opus → 48 → 24 kHz → `onAudio`.
 * Outbound: `play` → the Phase 7 `Pacer` → 24 → 48 kHz → Opus → RTP every 20 ms,
 * and a silent frame whenever nothing plays (Meta drops calls without media).
 * RTCP sender reports are sent by werift itself. `hangup` always asks Meta to
 * terminate (idempotent) before the peer closes.
 */
export interface WhatsAppLegSignaling {
  /** Graph `terminate` (the caller makes it idempotent / logs failures). */
  terminate(): Promise<void>;
  /** In-app transfer to a team member (T12.7); missing → `failed`. */
  transfer?(phoneLast4: string, timeoutSec: number): Promise<TransferResult>;
}

export interface WhatsAppLegOptions {
  peer: WhatsAppPeer;
  signaling: WhatsAppLegSignaling;
  clock?: Clock;
  /** No inbound media this long after the answer → `media_timeout`. */
  mediaTimeoutMs?: number;
  /** User-initiated calls send no business RTP until Graph accept succeeds. */
  waitForAnswer?: boolean;
}

export interface WhatsAppLegMetrics {
  setupMs: number | null;
  packetsIn: number;
  packetsOut: number;
  /** Packets missing in the inbound sequence (gaps), % of expected. */
  lossPct: number;
  /** RFC 3550 interarrival jitter (ms). */
  jitterMs: number;
  /** Not measured by werift for us (RTCP RR round trips) — null. */
  rttMs: number | null;
}

const FRAME_MS = CALL_LIMITS.frameMs;
const LEG_FRAME = (LEG_RATE * FRAME_MS) / 1000;
/** Reorder depth: `jitterBufferMs` of packets. */
const JITTER_DEPTH = Math.max(1, Math.round(WHATSAPP_CALL_LIMITS.jitterBufferMs / FRAME_MS));
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
/** A gap this large is a new stream (restart), not loss to conceal. */
const MAX_CONCEAL = 10;

const unref = (handle: unknown) => {
  (handle as { unref?: () => void } | null)?.unref?.();
};

/** `a − b` on the 16-bit RTP sequence circle (−32768 … 32767). */
const seqDiff = (a: number, b: number): number => {
  const d = (a - b) & 0xffff;
  return d >= 0x8000 ? d - 0x1_0000 : d;
};

export class WhatsAppCallLeg implements CallLeg {
  readonly rate = LEG_RATE;
  private readonly peer: WhatsAppPeer;
  private readonly signaling: WhatsAppLegSignaling;
  private readonly clock: Clock;
  private readonly codecIn: OpusCodec = createOpusCodec();
  private readonly codecOut: OpusCodec = createOpusCodec();
  private readonly resamplers = createLegResamplers();
  private readonly inFramer = new Framer(LEG_FRAME);
  private readonly outFramer = new Framer(OPUS_FRAME_SAMPLES);
  private readonly playFramer = new Framer(LEG_FRAME);
  private readonly pacer: Pacer;
  private readonly dtmf: DtmfReceiver;
  private audioFns: ((frame: Int16Array) => void)[] = [];
  private dtmfFns: ((digit: string) => void)[] = [];
  private statusFns: ((status: LegStatus, cause?: HangupCause) => void)[] = [];
  private outgoingFns: ((frame: Int16Array) => void)[] = [];
  private keepAlive: unknown = null;
  private mediaWatch: unknown = null;
  private lastSentAt = 0;
  private lastInboundAt = 0;
  private readonly mediaTimeoutMs: number;
  private readonly createdAt: number;
  private connectedAt: number | null = null;
  private answeredFlag = false;
  private ended = false;
  private closing: Promise<void> | null = null;
  private metaEnded = false;
  private readonly waitForAnswer: boolean;
  private jitter: ReceivedPacket[] = [];
  private nextSeq: number | null = null;
  private expected = 0;
  private received = 0;
  private sentPackets = 0;
  private jitterEstimate = 0;
  private lastTransit: number | null = null;
  private silenceFrame = new Int16Array(LEG_FRAME);

  constructor(options: WhatsAppLegOptions) {
    this.peer = options.peer;
    this.signaling = options.signaling;
    this.clock = options.clock ?? systemClock;
    this.mediaTimeoutMs = options.mediaTimeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
    this.waitForAnswer = options.waitForAnswer ?? false;
    this.createdAt = this.clock.now();
    this.pacer = new Pacer({
      clock: this.clock,
      frameMs: FRAME_MS,
      send: (f) => this.sendFrame(f),
    });
    this.dtmf = new DtmfReceiver((digit) => {
      for (const fn of this.dtmfFns) fn(digit);
    });
    this.peer.onPacket((p) => this.receive(p));
    this.peer.onState((state) => {
      if (state === 'connected') this.onConnected();
      if (state === 'failed') this.finish('media_error');
      if (state === 'closed') this.finish('customer_hangup');
    });
  }

  get playing(): boolean {
    return this.pacer.playing;
  }

  get metrics(): WhatsAppLegMetrics {
    const lost = Math.max(0, this.expected - this.received);
    return {
      setupMs: this.connectedAt === null ? null : this.connectedAt - this.createdAt,
      packetsIn: this.received,
      packetsOut: this.sentPackets,
      lossPct: this.expected ? Math.round((lost / this.expected) * 1000) / 10 : 0,
      jitterMs: Math.round((this.jitterEstimate / 48) * 10) / 10,
      rttMs: null,
    };
  }

  onAudio(fn: (frame: Int16Array) => void): void {
    this.audioFns.push(fn);
  }

  onDtmf(fn: (digit: string) => void): void {
    this.dtmfFns.push(fn);
  }

  /** WhatsApp has no typed customer text. */
  onText(): void {
    // nothing to subscribe to
  }

  onStatus(fn: (status: LegStatus, cause?: HangupCause) => void): void {
    this.statusFns.push(fn);
  }

  onOutgoing(fn: (frame: Int16Array) => void): void {
    this.outgoingFns.push(fn);
  }

  /** The phone rings (business-initiated: Meta's RINGING status). */
  ringing(): void {
    if (!this.ended) this.status('ringing');
  }

  /** The customer picked up (BIC: ACCEPTED; UIC: our accept went through). */
  answered(): void {
    if (this.ended || this.answeredFlag) return;
    this.answeredFlag = true;
    this.lastInboundAt = this.clock.now();
    this.watchMedia();
    if (this.connectedAt !== null) this.sendFrame(this.silenceFrame, false);
    this.status('answered');
  }

  /**
   * Meta ended / refused the call (terminate webhook, REJECTED): our hangup that follows
   * closes the media only — no terminate back. No status event (the caller ends the session).
   */
  endedByMeta(): void {
    this.metaEnded = true;
  }

  /** Meta ended the call (terminate webhook / REJECTED): no terminate back. */
  remoteEnded(cause: HangupCause): void {
    this.finish(cause, { terminate: false });
  }

  play(pcm: Int16Array, onStart?: () => void): Promise<PlaybackResult> {
    if (this.ended) return Promise.resolve({ completed: false, playedMs: 0 });
    const frames = this.playFramer.push(pcm);
    const last = this.playFramer.flush();
    if (last) frames.push(last);
    return this.pacer.play(frames, onStart);
  }

  clearAudio(): number {
    return this.pacer.clear();
  }

  /** Keys from the agent's keypad (RFC 4733), one digit after the other. */
  async sendDigits(digits: string): Promise<void> {
    for (const digit of digits) {
      if (this.ended || !DTMF_DIGITS.includes(digit)) continue;
      const start = this.peer.rtpTimestamp;
      const packets = dtmfPackets(digit);
      for (const [i, payload] of packets.entries()) {
        this.peer.sendPacket(DTMF_PT, payload, { samples: 0, marker: i === 0, timestamp: start });
        this.lastSentAt = this.clock.now();
        await this.wait(FRAME_MS);
      }
      this.peer.advance(OPUS_FRAME_SAMPLES * packets.length);
      await this.wait(60);
    }
  }

  transfer(phoneLast4: string, timeoutSec: number): Promise<TransferResult> {
    if (this.ended) return Promise.resolve('failed');
    return this.signaling.transfer?.(phoneLast4, timeoutSec) ?? Promise.resolve('failed');
  }

  /** WhatsApp shows nothing in the call for notices. */
  notify(notice: LegNotice): void {
    void notice;
  }

  /** Ends the call from our side: Meta terminate (always), then the peer closes. */
  hangup(cause: HangupCause): Promise<void> {
    void cause;
    if (this.closing) return this.closing;
    this.ended = true;
    this.stopMedia();
    this.closing = (async () => {
      if (!this.metaEnded) await this.signaling.terminate().catch(() => undefined);
      await this.peer.close();
      this.release();
    })();
    return this.closing;
  }

  private onConnected(): void {
    if (this.connectedAt !== null || this.ended) return;
    this.connectedAt = this.clock.now();
    // media from the first moment: silence until something plays
    this.lastSentAt = 0;
    // drift-free: every 20 ms slot without audio gets one silent frame (catching up
    // after a late timer, at most 3 at once)
    this.keepAlive = this.clock.setInterval(() => {
      if (this.ended || this.pacer.playing) return;
      const now = this.clock.now();
      if (now - this.lastSentAt > FRAME_MS * 10) this.lastSentAt = now - FRAME_MS;
      for (let i = 0; i < 3 && now - this.lastSentAt >= FRAME_MS - 1; i += 1) {
        this.sendFrame(this.silenceFrame, false, this.lastSentAt + FRAME_MS);
      }
    }, WHATSAPP_CALL_LIMITS.keepAliveEveryMs);
    unref(this.keepAlive);
    this.sendFrame(this.silenceFrame, false);
  }

  private watchMedia(): void {
    if (this.mediaWatch !== null) return;
    this.mediaWatch = this.clock.setInterval(() => {
      if (this.clock.now() - this.lastInboundAt > this.mediaTimeoutMs) this.finish('media_timeout');
    }, 1_000);
    unref(this.mediaWatch);
  }

  /** One 24 kHz frame out (paced audio, or keep-alive silence). */
  private sendFrame(frame24: Int16Array, outgoing = true, slot?: number): void {
    if (this.ended || this.connectedAt === null || (this.waitForAnswer && !this.answeredFlag))
      return;
    const up = this.resamplers.up.process(frame24);
    for (const frame48 of this.outFramer.push(up)) {
      this.peer.sendPacket(OPUS_PT, this.codecOut.encode(frame48), { samples: OPUS_FRAME_SAMPLES });
      this.sentPackets += 1;
    }
    this.lastSentAt = slot ?? this.clock.now();
    if (outgoing) for (const fn of this.outgoingFns) fn(frame24);
  }

  private receive(p: ReceivedPacket): void {
    if (this.ended) return;
    this.lastInboundAt = this.clock.now();
    if (p.payloadType === DTMF_PT) {
      this.dtmf.push(p.payload, p.timestamp);
      return;
    }
    if (p.payloadType !== OPUS_PT) return;
    this.received += 1;
    // RFC 3550 jitter in 48 kHz units
    const transit = (this.clock.now() * 48 - p.timestamp) >>> 0;
    if (this.lastTransit !== null) {
      const d = Math.abs(((transit - this.lastTransit + 0x8000_0000) >>> 0) - 0x8000_0000);
      this.jitterEstimate += (d - this.jitterEstimate) / 16;
    }
    this.lastTransit = transit;
    this.jitter.push(p);
    this.jitter.sort((a, b) => seqDiff(a.sequenceNumber, b.sequenceNumber));
    while (this.jitter.length > JITTER_DEPTH) this.release1();
  }

  /** Releases the oldest buffered packet, concealing a gap before it with silence. */
  private release1(): void {
    const p = this.jitter.shift();
    if (!p) return;
    if (this.nextSeq !== null) {
      const gap = seqDiff(p.sequenceNumber, this.nextSeq);
      if (gap < 0) return; // late duplicate
      this.expected += gap;
      if (gap > 0 && gap <= MAX_CONCEAL) {
        for (let i = 0; i < gap; i += 1) this.deliver(this.codecIn.decode(Buffer.alloc(0)));
      }
    }
    this.expected += 1;
    this.nextSeq = (p.sequenceNumber + 1) & 0xffff;
    this.deliver(this.codecIn.decode(p.payload));
  }

  private deliver(pcm48: Int16Array): void {
    const down = this.resamplers.down.process(pcm48);
    for (const frame of this.inFramer.push(down)) for (const fn of this.audioFns) fn(frame);
  }

  private finish(cause: HangupCause, opts: { terminate?: boolean } = {}): void {
    if (this.ended) return;
    this.ended = true;
    this.stopMedia();
    this.status('ended', cause);
    if (opts.terminate !== false && cause !== 'customer_hangup') {
      void this.signaling.terminate().catch(() => undefined);
    }
    this.closing ??= this.peer.close().then(() => this.release());
  }

  private stopMedia(): void {
    this.pacer.clear();
    if (this.keepAlive !== null) this.clock.clearInterval(this.keepAlive);
    if (this.mediaWatch !== null) this.clock.clearInterval(this.mediaWatch);
    this.keepAlive = null;
    this.mediaWatch = null;
  }

  private released = false;
  private release(): void {
    if (this.released) return;
    this.released = true;
    this.codecIn.destroy();
    this.codecOut.destroy();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      unref(this.clock.setTimeout(resolve, ms));
    });
  }

  private status(status: LegStatus, cause?: HangupCause): void {
    for (const fn of this.statusFns) fn(status, cause);
  }
}
