import { Framer } from '../../voice/audio/framer';
import { Pacer, type PlaybackResult } from '../../voice/audio/pacer';
import type { Clock } from '../../voice/clock';
import type {
  CallLeg,
  HangupCause,
  LegNotice,
  LegStatus,
  TransferResult,
  TransferTarget,
} from '../types';

import type { AriChannel, AriClient, AriEvent } from './ari-client';
import { toHangupCause } from './causes';
import { SIP_FRAME_SAMPLES, type G711, type RtpSession } from './rtp-session';

/** Channel ids of one call (ADR 0050): the call id makes a retried dial idempotent. */
export const sipIds = (callId: string) => ({
  main: `cav-${callId}`,
  media: `cav-${callId}-em`,
  bridge: `cav-${callId}-br`,
  transfer: `cav-${callId}-xfer`,
});

export interface SipLegOptions {
  callId: string;
  to: string;
  callerId: string;
  /** PJSIP endpoint of the trunk (`trunk`). */
  trunk: string;
  format: G711;
  ringTimeoutSec: number;
  mediaTimeoutSec: number;
  /** Where Asterisk reaches our RTP socket (127.0.0.1 with host networking). */
  advertiseHost: string;
  /** Where we reach Asterisk's ExternalMedia port. */
  asteriskRtpHost: string;
  /** Run answering machine detection in the dialplan first. */
  amd: boolean;
  /** False when the campaign leaves a message on a machine (the bot speaks). */
  hangupOnMachine: boolean;
  /** ARI app of the dialing process (the AMD dialplan returns the call to it). */
  app: string;
  /** Trunk channel for the transfer leg (T18.8); absent = no limit. */
  channels?: { acquire(id: string): Promise<boolean>; release(id: string): void };
}

export interface SipLegMetrics {
  codec: G711;
  sipQ850: number | null;
  dialStatus: string | null;
  amd: string | null;
  amdCause: string | null;
  amdMs: number | null;
  packetsIn: number;
  packetsOut: number;
  lossPct: number;
  jitterMs: number;
  /** Answer → first customer packet. */
  firstAudioMs: number | null;
}

const HANGUP_REASON: Partial<Record<HangupCause, string>> = {
  busy: 'busy',
  no_answer: 'no_answer',
  rejected: 'busy',
  limit: 'congestion',
  media_error: 'congestion',
};

/** Our hangup is confirmed by ChannelDestroyed; this long without it, we end anyway. */
const HANGUP_CONFIRM_MS = 2000;
const MEDIA_CHECK_MS = 1000;

/** A phone call over the SIP trunk: Asterisk channel + ExternalMedia RTP at 8 kHz. */
export class SipCallLeg implements CallLeg {
  readonly rate = 8_000;
  readonly ids: ReturnType<typeof sipIds>;
  private readonly pacer: Pacer;
  private readonly framer = new Framer(SIP_FRAME_SAMPLES);
  private readonly statusFns: ((status: LegStatus, cause?: HangupCause) => void)[] = [];
  private readonly outgoingFns: ((frame: Int16Array) => void)[] = [];
  private readonly dtmfFns: ((digit: string) => void)[] = [];
  private state: LegStatus | 'new' = 'new';
  private answeredAt: number | null = null;
  private dialedAt: number | null = null;
  private ourHangup = false;
  private askedCause: HangupCause | null = null;
  private q850: number | null = null;
  private dialStatus: string | null = null;
  private amdStatus: string | null = null;
  private amdCause: string | null = null;
  private amdMs: number | null = null;
  private firstAudioMs: number | null = null;
  private mediaTimer: unknown = null;
  private confirmTimer: unknown = null;
  private transferring: {
    resolve: (r: TransferResult) => void;
    timer: unknown;
  } | null = null;
  private transferred = false;
  private endedFns: (() => void)[] = [];

  constructor(
    private readonly ari: AriClient,
    private readonly rtp: RtpSession,
    private readonly clock: Clock,
    private readonly options: SipLegOptions,
  ) {
    this.ids = sipIds(options.callId);
    this.pacer = new Pacer({
      clock,
      frameMs: 20,
      send: (frame) => {
        if (this.transferred) return;
        rtp.send(frame);
        for (const fn of this.outgoingFns) fn(frame);
      },
    });
    rtp.onFrame(() => {
      if (this.firstAudioMs === null && this.answeredAt !== null) {
        this.firstAudioMs = this.clock.now() - this.answeredAt;
      }
    });
  }

  get playing(): boolean {
    return this.pacer.playing;
  }

  get ended(): boolean {
    return this.state === 'ended';
  }

  get metrics(): SipLegMetrics {
    const s = this.rtp.stats;
    return {
      codec: this.options.format,
      sipQ850: this.q850,
      dialStatus: this.dialStatus,
      amd: this.amdStatus,
      amdCause: this.amdCause,
      amdMs: this.amdMs,
      packetsIn: s.packetsIn,
      packetsOut: s.packetsOut,
      lossPct: s.lossPct,
      jitterMs: s.jitterMs,
      firstAudioMs: this.firstAudioMs,
    };
  }

  /** The provider forgets the leg (and frees its port) through this. */
  onEnded(fn: () => void): void {
    this.endedFns.push(fn);
  }

  onAudio(fn: (frame: Int16Array) => void): void {
    this.rtp.onFrame((frame) => {
      if (this.state === 'answered' && !this.transferred) fn(frame);
    });
  }

  onDtmf(fn: (digit: string) => void): void {
    this.dtmfFns.push(fn);
  }

  /** Typed text exists on web calls only. */
  onText(fn: (text: string) => void): void {
    void fn;
  }

  onStatus(fn: (status: LegStatus, cause?: HangupCause) => void): void {
    this.statusFns.push(fn);
  }

  onOutgoing(fn: (frame: Int16Array) => void): void {
    this.outgoingFns.push(fn);
  }

  /** Places the call (after the session listens). Failures end the leg as `media_error`. */
  async dial(): Promise<void> {
    if (this.state !== 'new') return;
    this.dialedAt = this.clock.now();
    try {
      await this.ari.originate({
        channelId: this.ids.main,
        endpoint: `PJSIP/${this.options.to}@${this.options.trunk}`,
        callerId: this.options.callerId,
        timeoutSec: this.options.ringTimeoutSec,
        appArgs: this.options.callId,
        ...(this.options.amd ? { dialplan: { context: 'cav-amd', extension: 's' } } : {}),
        variables: { CAV_CALL_ID: this.options.callId, CAV_APP: this.options.app },
      });
    } catch {
      this.finish('media_error');
    }
  }

  /** ARI events for this call's channels (routed by the provider). */
  handle(event: AriEvent): void {
    if (this.state === 'ended') return;
    const id =
      event.type === 'Dial' ? event.peer.id : 'channel' in event ? event.channel?.id : null;
    if (id === this.ids.transfer) {
      this.handleTransfer(event);
      return;
    }
    if (id !== this.ids.main) return;
    switch (event.type) {
      case 'ChannelStateChange':
        if (event.channel.state === 'Ringing' || event.channel.state === 'Ring')
          this.status('ringing');
        break;
      case 'Dial':
        if (event.dialstatus) this.dialStatus = event.dialstatus;
        break;
      case 'StasisStart':
        void this.answered(event.channel, event.args);
        break;
      case 'ChannelDtmfReceived':
        if (this.state === 'answered' && !this.transferred) {
          for (const fn of this.dtmfFns) fn(event.digit);
        }
        break;
      case 'ChannelHangupRequest':
        if (event.cause !== undefined) this.q850 = event.cause;
        break;
      case 'ChannelDestroyed':
        this.q850 = event.cause;
        this.finish(this.endCause());
        break;
      default:
        break;
    }
  }

  private endCause(): HangupCause {
    if (this.askedCause) return this.askedCause;
    return toHangupCause({
      q850: this.q850,
      dialStatus: this.dialStatus,
      answered: this.answeredAt !== null,
      ourHangup: this.ourHangup,
      amd: this.amdStatus,
    });
  }

  private async answered(channel: AriChannel, args: string[]): Promise<void> {
    if (this.answeredAt !== null) return;
    if (args[0] === 'amd') {
      this.amdStatus = args[1] ?? null;
      this.amdCause = args[2] ?? null;
      this.amdMs = this.dialedAt === null ? null : this.clock.now() - this.dialedAt;
      if (this.amdStatus === 'MACHINE' && this.options.hangupOnMachine) {
        await this.hangup('machine');
        return;
      }
    }
    void channel;
    this.answeredAt = this.clock.now();
    try {
      await this.ari.createBridge(this.ids.bridge);
      const media = await this.ari.externalMedia({
        channelId: this.ids.media,
        externalHost: `${this.options.advertiseHost}:${String(this.rtp.port)}`,
        format: this.options.format,
      });
      const port = Number(media.channelvars?.UNICASTRTP_LOCAL_PORT);
      if (!Number.isInteger(port) || port <= 0) throw new Error('no ExternalMedia port');
      this.rtp.setPeer(this.options.asteriskRtpHost, port);
      await this.ari.addToBridge(this.ids.bridge, [this.ids.main, this.ids.media]);
    } catch {
      await this.hangup('media_error');
      return;
    }
    if (this.state === 'ended') return;
    this.status('answered');
    this.mediaTimer = this.clock.setInterval(() => this.checkMedia(), MEDIA_CHECK_MS);
  }

  private checkMedia(): void {
    if (this.state !== 'answered' || this.transferred) return;
    const last = this.rtp.lastPacketAt ?? this.answeredAt ?? this.clock.now();
    if (this.clock.now() - last > this.options.mediaTimeoutSec * 1000) {
      void this.hangup('media_timeout');
    }
  }

  play(pcm: Int16Array, onStart?: () => void): Promise<PlaybackResult> {
    if (this.state === 'ended' || this.transferred) {
      return Promise.resolve({ completed: false, playedMs: 0 });
    }
    const frames = this.framer.push(pcm);
    const last = this.framer.flush();
    if (last) frames.push(last);
    return this.pacer.play(frames, onStart);
  }

  clearAudio(): number {
    const played = this.pacer.clear();
    this.rtp.markTalkStart();
    return played;
  }

  transfer(target: TransferTarget, timeoutSec: number): Promise<TransferResult> {
    if (this.state !== 'answered' || this.transferring || this.transferred) {
      return Promise.resolve('failed');
    }
    if (!/^\+[1-9]\d{7,14}$/.test(target.phone)) return Promise.resolve('failed');
    return this.startTransfer(target, timeoutSec);
  }

  private async startTransfer(target: TransferTarget, timeoutSec: number): Promise<TransferResult> {
    const leaseId = `${this.options.callId}:xfer`;
    if (this.options.channels && !(await this.options.channels.acquire(leaseId))) return 'failed';
    const result = await new Promise<TransferResult>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        void this.ari.hangup(this.ids.transfer).catch(() => undefined);
        this.transferDone('no_answer');
      }, timeoutSec * 1000);
      this.transferring = { resolve, timer };
      this.ari
        .originate({
          channelId: this.ids.transfer,
          endpoint: `PJSIP/${target.phone}@${this.options.trunk}`,
          callerId: this.options.callerId,
          timeoutSec,
          appArgs: `${this.options.callId},transfer`,
        })
        .catch(() => this.transferDone('failed'));
    });
    if (result !== 'connected') this.options.channels?.release(leaseId);
    return result;
  }

  private transferDone(result: TransferResult): void {
    const t = this.transferring;
    if (!t) return;
    this.transferring = null;
    this.clock.clearTimeout(t.timer);
    t.resolve(result);
  }

  private handleTransfer(event: AriEvent): void {
    if (event.type === 'StasisStart' && this.transferring) {
      void (async () => {
        try {
          this.pacer.clear();
          await this.ari.removeFromBridge(this.ids.bridge, [this.ids.media]);
          await this.ari.addToBridge(this.ids.bridge, [this.ids.transfer]);
          this.transferred = true;
          this.transferDone('connected');
        } catch {
          void this.ari.hangup(this.ids.transfer).catch(() => undefined);
          this.transferDone('failed');
        }
      })();
      return;
    }
    if (event.type === 'ChannelDestroyed') {
      if (this.transferring) {
        const cause = toHangupCause({
          q850: event.cause,
          dialStatus: null,
          answered: false,
          ourHangup: false,
          amd: null,
        });
        this.transferDone(cause === 'busy' || cause === 'no_answer' ? 'no_answer' : 'failed');
      } else if (this.transferred) {
        // the agent hung up: the call is over
        void this.hangup('normal');
      }
    }
  }

  /** Asterisk no longer has the channel (restart): end without asking it anything. */
  lost(): void {
    this.finish(this.askedCause ?? 'media_error');
  }

  /** Notices are for web calls; a phone shows nothing. */
  notify(notice: LegNotice): void {
    void notice;
  }

  async hangup(cause: HangupCause): Promise<void> {
    if (this.state === 'ended' || this.askedCause) return;
    this.ourHangup = true;
    this.askedCause = cause;
    this.pacer.clear();
    if (this.dialedAt === null) {
      this.finish(cause);
      return;
    }
    this.confirmTimer = this.clock.setTimeout(() => this.finish(cause), HANGUP_CONFIRM_MS);
    if (this.transferred || this.transferring) {
      await this.ari.hangup(this.ids.transfer).catch(() => undefined);
    }
    await this.ari.hangup(this.ids.main, HANGUP_REASON[cause] ?? 'normal').catch(() => {
      // already gone: ChannelDestroyed came or will not come; the timer ends the leg
    });
  }

  private status(status: LegStatus, cause?: HangupCause): void {
    if (this.state === status || this.state === 'ended') return;
    if (status === 'ringing' && this.state === 'answered') return;
    this.state = status;
    for (const fn of this.statusFns) fn(status, cause);
  }

  private finish(cause: HangupCause): void {
    if (this.state === 'ended') return;
    if (this.mediaTimer !== null) this.clock.clearInterval(this.mediaTimer);
    if (this.confirmTimer !== null) this.clock.clearTimeout(this.confirmTimer);
    this.mediaTimer = null;
    this.confirmTimer = null;
    this.transferDone('failed');
    this.pacer.clear();
    this.status('ended', cause);
    void this.ari.hangup(this.ids.media).catch(() => undefined);
    void this.ari.destroyBridge(this.ids.bridge).catch(() => undefined);
    if (this.transferred) void this.ari.hangup(this.ids.transfer).catch(() => undefined);
    this.rtp.close();
    for (const fn of this.endedFns.splice(0)) fn();
  }
}
