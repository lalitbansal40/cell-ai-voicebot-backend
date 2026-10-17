import type { PlaybackResult } from '../voice/audio/pacer';

export type LegStatus = 'ringing' | 'answered' | 'ended';

export type HangupCause =
  | 'normal'
  | 'customer_hangup'
  | 'media_timeout'
  | 'media_error'
  | 'server_shutdown'
  | 'limit'
  // phone legs before the answer (dry run now, SIP in Phase 13)
  | 'busy'
  | 'no_answer'
  | 'rejected'
  | 'invalid_number';

export type TransferResult = 'connected' | 'failed' | 'no_answer';

/** Messages a web tester shows (transcript, events) — no-op on phone legs. */
export type LegNotice = { type: string } & Record<string, unknown>;

/**
 * One side of a call (ADR 0020). Audio is PCM16 mono at `rate` in 20 ms frames;
 * the leg paces outgoing audio in real time.
 */
export interface CallLeg {
  readonly rate: 24_000 | 8_000;
  onAudio(fn: (frame: Int16Array) => void): void;
  onDtmf(fn: (digit: string) => void): void;
  /** Typed customer words (dev / tests, web calls only). */
  onText(fn: (text: string) => void): void;
  onStatus(fn: (status: LegStatus, cause?: HangupCause) => void): void;
  /** Every outgoing frame as it is sent (recording, latency). */
  onOutgoing(fn: (frame: Int16Array) => void): void;
  /** Queues a clip; resolves when it was fully played or cleared. */
  play(pcm: Int16Array, onStart?: () => void): Promise<PlaybackResult>;
  /** Stops playback now (barge-in); returns ms played of the current clip. */
  clearAudio(): number;
  readonly playing: boolean;
  transfer(phoneLast4: string, timeoutSec: number): Promise<TransferResult>;
  notify(notice: LegNotice): void;
  hangup(cause: HangupCause, notice?: LegNotice): Promise<void>;
}

export interface StartCallRequest {
  callId: string;
  to: string;
}

export interface TelephonyProvider {
  readonly name: 'webcall' | 'sip';
  startCall(request: StartCallRequest): Promise<CallLeg>;
}
