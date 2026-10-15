import { CALL_LIMITS } from '../../config/limits';
import { Framer } from '../voice/audio/framer';
import { Pacer } from '../voice/audio/pacer';
import { toBytes } from '../voice/audio/pcm';
import type { Clock } from '../voice/clock';

import type { CallLeg, HangupCause, LegNotice, LegStatus, TransferResult } from './types';

/** What the media socket gives a web call leg (`/ws/media`). */
export interface MediaChannel {
  sendJson(message: LegNotice): void;
  sendBinary(frame: Buffer): void;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

export type ControlMessage =
  | { type: 'call.ready'; sampleRate: number }
  | { type: 'call.dtmf'; digit: string }
  | { type: 'call.hangup' }
  | { type: 'call.transfer_result'; result: TransferResult }
  | { type: 'call.say_text'; text: string }
  | { type: 'call.mute'; muted: boolean };

const CAUSE_CLOSE: Record<HangupCause, number> = {
  normal: 1000,
  customer_hangup: 1000,
  media_timeout: 1000,
  media_error: 1011,
  server_shutdown: 1001,
  limit: 1000,
};

/** Browser call leg: 24 kHz PCM16 frames over the media socket, paced in real time. */
export class WebCallLeg implements CallLeg {
  readonly rate = CALL_LIMITS.webSampleRate;
  private readonly pacer: Pacer;
  private readonly framer = new Framer((CALL_LIMITS.webSampleRate * CALL_LIMITS.frameMs) / 1000);
  private audioFns: ((frame: Int16Array) => void)[] = [];
  private dtmfFns: ((digit: string) => void)[] = [];
  private textFns: ((text: string) => void)[] = [];
  private statusFns: ((status: LegStatus, cause?: HangupCause) => void)[] = [];
  private outgoingFns: ((frame: Int16Array) => void)[] = [];
  private pendingTransfer: ((result: TransferResult) => void) | null = null;
  private muted = false;
  private ended = false;

  constructor(
    private readonly channel: MediaChannel,
    private readonly clock: Clock,
  ) {
    this.pacer = new Pacer({
      clock,
      frameMs: CALL_LIMITS.frameMs,
      send: (frame) => {
        channel.sendBinary(toBytes(frame));
        for (const fn of this.outgoingFns) fn(frame);
      },
      congested: () => channel.bufferedAmount() > CALL_LIMITS.backpressureBytes,
    });
  }

  /** Pacer health for benches / metrics: late timer ticks, frames held back by backpressure. */
  get pacerStats(): { lateTicks: number; stalledFrames: number } {
    return { lateTicks: this.pacer.lateTicks, stalledFrames: this.pacer.stalledFrames };
  }

  get playing(): boolean {
    return this.pacer.playing;
  }

  onAudio(fn: (frame: Int16Array) => void): void {
    this.audioFns.push(fn);
  }

  onOutgoing(fn: (frame: Int16Array) => void): void {
    this.outgoingFns.push(fn);
  }

  onDtmf(fn: (digit: string) => void): void {
    this.dtmfFns.push(fn);
  }

  onText(fn: (text: string) => void): void {
    this.textFns.push(fn);
  }

  onStatus(fn: (status: LegStatus, cause?: HangupCause) => void): void {
    this.statusFns.push(fn);
  }

  /** Customer audio frame (already size-checked by the media server). */
  receiveAudio(frame: Int16Array): void {
    if (this.ended) return;
    // a muted tester still sends frames — they count as silence
    const audio = this.muted ? new Int16Array(frame.length) : frame;
    for (const fn of this.audioFns) fn(audio);
  }

  receiveControl(message: ControlMessage): void {
    if (this.ended) return;
    switch (message.type) {
      case 'call.ready':
        this.status('answered');
        break;
      case 'call.dtmf':
        for (const fn of this.dtmfFns) fn(message.digit);
        break;
      case 'call.say_text':
        for (const fn of this.textFns) fn(message.text);
        break;
      case 'call.mute':
        this.muted = message.muted;
        break;
      case 'call.transfer_result':
        this.pendingTransfer?.(message.result);
        break;
      case 'call.hangup':
        this.finish('customer_hangup');
        break;
    }
  }

  /** The socket closed (or dropped). */
  socketClosed(cause: HangupCause = 'customer_hangup'): void {
    this.finish(cause);
  }

  ringing(): void {
    this.status('ringing');
  }

  play(pcm: Int16Array, onStart?: () => void) {
    const frames = this.framer.push(pcm);
    const last = this.framer.flush();
    if (last) frames.push(last);
    return this.pacer.play(frames, onStart);
  }

  clearAudio(): number {
    const played = this.pacer.clear();
    this.notify({ type: 'audio.clear' });
    return played;
  }

  transfer(phoneLast4: string, timeoutSec: number): Promise<TransferResult> {
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => done('no_answer'), timeoutSec * 1000);
      const done = (result: TransferResult) => {
        this.clock.clearTimeout(timer);
        this.pendingTransfer = null;
        resolve(result);
      };
      this.pendingTransfer = done;
      this.notify({ type: 'call.transfer', phoneLast4 });
    });
  }

  notify(notice: LegNotice): void {
    if (!this.ended) this.channel.sendJson(notice);
  }

  hangup(cause: HangupCause, notice?: LegNotice): Promise<void> {
    if (notice) this.notify(notice);
    this.pacer.clear();
    if (!this.ended) {
      this.ended = true;
      this.pendingTransfer?.('failed');
      this.channel.close(CAUSE_CLOSE[cause], cause);
    }
    return Promise.resolve();
  }

  private finish(cause: HangupCause): void {
    if (this.ended) return;
    this.ended = true;
    this.pacer.clear();
    this.pendingTransfer?.('failed');
    this.status('ended', cause);
  }

  private status(status: LegStatus, cause?: HangupCause): void {
    for (const fn of this.statusFns) fn(status, cause);
  }
}
