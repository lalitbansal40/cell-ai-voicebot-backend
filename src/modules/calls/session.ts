import { rm } from 'node:fs/promises';

import { CALL_LIMITS, CALL_LINES } from '../../config/limits';
import { tryGetRealtime } from '../../core/realtime';
import { notifyAccount } from '../../core/realtime/notify';
import type { StorageProvider } from '../../core/storage';
import type { CallLeg, HangupCause } from '../../core/telephony/types';
import type { PlaybackResult } from '../../core/voice/audio/pacer';
import type { Clock } from '../../core/voice/clock';
import { LatencyMeter } from '../../core/voice/latency';
import type { TtsCache } from '../../core/voice/tts-cache';
import { CallEventModel, type CallEventType } from '../../db/models/call-event.model';
import {
  CallModel,
  emptyCallCost,
  emptyCallMetrics,
  type CallCost,
  type CallDoc,
  type CallEndReason,
  type CallMetrics,
  type CallRecording,
  type CallStatus,
} from '../../db/models/call.model';
import {
  TranscriptTurnModel,
  type TranscriptSource,
  type TranscriptSpeaker,
} from '../../db/models/transcript-turn.model';
import type { Logger } from '../../shared/logger';

import type { CallBillingPort } from './billing';
import { finalStatus, endReasonFor } from './lifecycle';
import { CallRecorder, uploadRecording } from './recording';
import type { CallRegistry } from './registry';

export interface SayOptions {
  language?: string;
  /** Customer speech may cut it (barge-in). Default true. */
  interruptible?: boolean;
  source?: TranscriptSource;
  voice?: string;
  tone?: string;
}

export interface TranscriptOptions {
  source: TranscriptSource;
  language?: string | null;
  startMs?: number;
  endMs?: number;
  interrupted?: boolean;
}

/** A bot reply that arrives in pieces (Realtime audio deltas). */
export interface BotStream {
  /** More bot audio at the leg rate; whole 20 ms frames go out at once. */
  push(pcm: Int16Array): void;
  /** Plays the rest, waits for the end (or a barge-in) and writes the bot line. */
  finish(text: string, language?: string | null): Promise<PlaybackResult>;
}

/** What a call script (flow host / AI agent) can do on a live call. */
export interface CallIO {
  readonly callId: string;
  readonly accountId: string;
  readonly leg: CallLeg;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: CallMetrics;
  readonly ended: boolean;
  /** ms since the call was answered. */
  elapsedMs(): number;
  /** TTS (cached) → plays → final bot transcript line. */
  say(text: string, options?: SayOptions): Promise<PlaybackResult>;
  /** Plays prepared audio; `text` (if any) becomes the bot transcript line. */
  play(pcm: Int16Array, text: string | null, source: TranscriptSource): Promise<PlaybackResult>;
  /** Streams a reply whose audio arrives in pieces (barge-in counts like `say`). */
  stream(source: TranscriptSource): BotStream;
  /** Barge-in: stops the bot now; returns ms played of the current clip. */
  interrupt(): number;
  transcript(speaker: TranscriptSpeaker, text: string, options: TranscriptOptions): void;
  /** Live partial text for the tester only (never stored). */
  partial(speaker: TranscriptSpeaker, text: string): void;
  event(type: CallEventType, data?: Record<string, unknown>): void;
  /** Customer finished speaking / pressed a key (latency start). */
  customerDone(): void;
  /** Ends the call for `reason` (async; the script is stopped). */
  end(reason: CallEndReason): void;
}

export interface ScriptResult {
  outcome: Record<string, unknown>;
  disposition: string | null;
  variables: Record<string, string>;
  flowRunId: string | null;
  aiSeconds: number;
  languageDetected: string | null;
}

/** The program a call runs (Phase 6 flow host or an AI agent). */
export interface CallScript {
  run(io: CallIO): Promise<CallEndReason | void>;
  stop(reason: CallEndReason): Promise<void>;
  result(): ScriptResult;
}

export interface SessionDeps {
  call: Pick<CallDoc, '_id' | 'accountId' | 'startedBy' | 'provider'> &
    Partial<Pick<CallDoc, 'campaignId'>> & { voice?: string };
  leg: CallLeg;
  clock: Clock;
  logger: Logger;
  tts: Pick<TtsCache, 'get'>;
  storage: StorageProvider | undefined;
  registry: CallRegistry;
  billing: CallBillingPort;
  script: CallScript;
  recordingDir: string;
  recording: { enabled: boolean; notice: string };
  /** Default TTS voice / language for fixed lines. */
  voice: string;
  language: string;
  /** The program's own limit (flow settings / agent behaviour); the hard cap still applies. */
  maxDurationSec?: number;
  /**
   * `none`: the leg carries no audio (dry run) — no 20 ms tick and no idle
   * timeout; timers, heartbeat and the wallet check still run.
   */
  media?: 'audio' | 'none';
  /**
   * No answer this long after `start` → the call ends (Phase 12: WhatsApp calls ring
   * longer than a browser takes to connect). Default `readyTimeoutSec` / `media_timeout`.
   */
  answerTimeout?: { sec: number; reason: CallEndReason };
  onEnded?: (summary: CallEndedSummary) => void;
}

export interface CallEndedSummary {
  callId: string;
  accountId: string;
  status: CallStatus;
  endReason: CallEndReason;
  durationSec: number;
  costMicros: number;
  disposition: string | null;
  outcome: Record<string, unknown>;
}

const LEG_CAUSE: Partial<Record<CallEndReason, HangupCause>> = {
  media_error: 'media_error',
  media_timeout: 'media_timeout',
  server_shutdown: 'server_shutdown',
  limit: 'limit',
};

/** One live call: owns its leg, clock, timers, recording, billing and persistence. */
export class CallSession {
  readonly callId: string;
  readonly accountId: string;
  private readonly metrics: CallMetrics = emptyCallMetrics();
  private readonly latency = new LatencyMeter();
  private readonly timers: unknown[] = [];
  private readonly intervals: unknown[] = [];
  private recorder: CallRecorder | null = null;
  private answeredAt: number | null = null;
  private lastAudioAt = 0;
  private seqEvents = 0;
  private seqTranscript = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private botLine: { text: string; startMs: number; source: TranscriptSource } | null = null;
  private endPromise: Promise<CallEndedSummary> | null = null;
  /** A polite end is saying its line: the script returning must not end the call first. */
  private politeReason: CallEndReason | null = null;
  private endedFlag = false;
  private walletChecking = false;

  constructor(private readonly deps: SessionDeps) {
    this.callId = deps.call._id.toString();
    this.accountId = deps.call.accountId.toString();
  }

  get ended(): boolean {
    return this.endedFlag;
  }

  /** The socket is attached: ringing, wait for the microphone. */
  async start(): Promise<void> {
    const { leg, clock } = this.deps;
    leg.onStatus((status, cause) => {
      if (status === 'answered') void this.answered();
      else if (status === 'ended') void this.end(endReasonFor(cause));
    });
    leg.onAudio((frame) => {
      this.metrics.framesIn += 1;
      this.lastAudioAt = clock.now();
      this.recorder?.customer(frame);
    });
    leg.onOutgoing((frame) => {
      this.metrics.framesOut += 1;
      this.recorder?.bot(frame);
      const ms = this.latency.botAudio(clock.now());
      if (ms !== null) this.event('latency', { ms });
    });
    await this.setStatus('ringing', { 'timestamps.ringingAt': new Date(clock.now()) });
    const answerTimeout = this.deps.answerTimeout ?? {
      sec: CALL_LIMITS.readyTimeoutSec,
      reason: 'media_timeout' as const,
    };
    this.timers.push(
      clock.setTimeout(() => {
        if (this.answeredAt === null) void this.end(answerTimeout.reason);
      }, answerTimeout.sec * 1000),
    );
  }

  private async answered(): Promise<void> {
    if (this.answeredAt !== null || this.endedFlag) return;
    const { clock } = this.deps;
    const deps = this.deps;
    this.answeredAt = clock.now();
    this.lastAudioAt = this.answeredAt;
    // timers first: nothing may slip through while the I/O below runs
    if (deps.media !== 'none') {
      this.intervals.push(clock.setInterval(() => this.tick(), CALL_LIMITS.frameMs));
    }
    this.intervals.push(
      clock.setInterval(() => {
        void deps.registry
          .heartbeat(this.callId, this.accountId, this.answeredAt ?? clock.now(), clock.now())
          .catch((err: unknown) =>
            deps.logger.warn({ err, callId: this.callId }, 'call: heartbeat failed'),
          );
      }, CALL_LIMITS.heartbeatSec * 1000),
      clock.setInterval(() => void this.checkWallet(), CALL_LIMITS.holdCheckEverySec * 1000),
    );
    this.timers.push(
      clock.setTimeout(
        () => void this.end('max_duration'),
        Math.min(deps.maxDurationSec ?? CALL_LIMITS.maxCallSecHard, CALL_LIMITS.maxCallSecHard) *
          1000,
      ),
    );
    await this.setStatus('in_progress', { 'timestamps.answeredAt': new Date(this.answeredAt) });
    if (deps.recording.enabled) {
      try {
        const recorder = await CallRecorder.open(deps.recordingDir, this.callId, deps.leg.rate);
        if (this.endedFlag) {
          await recorder.close();
          await rm(recorder.file, { force: true });
        } else this.recorder = recorder;
      } catch (err) {
        deps.logger.warn({ err, callId: this.callId }, 'call: recording could not start');
        this.event('recording_failed', { stage: 'open' });
      }
    }
    if (!this.endedFlag) void this.runScript();
  }

  private async runScript(): Promise<void> {
    const io = this.io();
    try {
      if (this.deps.recording.enabled && this.deps.recording.notice.trim()) {
        await io.say(this.deps.recording.notice, { interruptible: false, source: 'system' });
      }
      if (this.endedFlag) return;
      const reason = await this.deps.script.run(io);
      if (!this.endedFlag && this.politeReason === null) await this.end(reason ?? 'hangup_node');
    } catch (err) {
      this.deps.logger.error({ err, callId: this.callId }, 'call: script failed');
      this.event('error', { code: 'engine_error' });
      await this.end('engine_error');
    }
  }

  private tick(): void {
    this.recorder?.tick();
    if (
      this.answeredAt !== null &&
      this.deps.clock.now() - this.lastAudioAt > CALL_LIMITS.inboundIdleSec * 1000
    ) {
      void this.end('media_timeout');
    }
  }

  private async checkWallet(): Promise<void> {
    if (this.walletChecking || this.endedFlag || this.answeredAt === null) return;
    const elapsedSec = (this.deps.clock.now() - this.answeredAt) / 1000;
    if (!this.deps.billing.needsExtension(elapsedSec)) return;
    this.walletChecking = true;
    try {
      const ok = await this.deps.billing.extend();
      this.event('wallet_extend', { ok });
      if (!ok) await this.politeEnd(CALL_LINES.walletEmpty, 'wallet_empty');
    } catch (err) {
      this.deps.logger.error({ err, callId: this.callId }, 'call: hold extension failed');
    } finally {
      this.walletChecking = false;
    }
  }

  /** Stops the script, says a fixed line (bounded) and ends. */
  async politeEnd(
    line: string,
    reason: CallEndReason,
    maxMs = CALL_LIMITS.shutdownLineMaxSec * 1000,
  ): Promise<CallEndedSummary> {
    if (this.endPromise) return this.endPromise;
    if (this.politeReason !== null) return this.end(this.politeReason);
    this.politeReason = reason;
    if (this.answeredAt !== null) {
      await this.deps.script.stop(reason).catch(() => undefined);
      this.deps.leg.clearAudio();
      const said = this.io().say(line, { interruptible: false, source: 'system' });
      await Promise.race([
        said,
        new Promise((resolve) => this.deps.clock.setTimeout(() => resolve(null), maxMs)),
      ]);
    }
    return this.end(reason);
  }

  private io(): CallIO {
    const isEnded = () => this.endedFlag;
    const { clock, leg, logger } = this.deps;
    return {
      callId: this.callId,
      accountId: this.accountId,
      leg,
      clock,
      logger,
      metrics: this.metrics,
      get ended() {
        return isEnded();
      },
      elapsedMs: () => (this.answeredAt === null ? 0 : clock.now() - this.answeredAt),
      say: async (text, options = {}) => {
        const language = options.language ?? this.deps.language;
        const { pcm, cached } = await this.deps.tts.get({
          text,
          voice: options.voice ?? this.deps.voice,
          language,
          ...(options.tone ? { tone: options.tone } : {}),
        });
        this.metrics.ttsChars += text.length;
        if (cached) this.metrics.ttsCachedChars += text.length;
        this.event('tts', { chars: text.length, cached });
        return this.playLine(pcm, text, options.source ?? 'tts', language);
      },
      play: (pcm, text, source) => this.playLine(pcm, text, source, null),
      stream: (source) => this.openStream(source),
      interrupt: () => {
        const played = leg.clearAudio();
        if (this.botLine) {
          this.metrics.bargeIns += 1;
          this.event('barge_in', { playedMs: played });
        }
        return played;
      },
      transcript: (speaker, text, options) => this.transcript(speaker, text, options),
      partial: (speaker, text) => {
        leg.notify({
          type: 'call.transcript',
          seq: this.seqTranscript + 1,
          speaker,
          text,
          final: false,
        });
      },
      event: (type, data) => this.event(type, data),
      customerDone: () => this.latency.customerDone(clock.now()),
      end: (reason) => void this.end(reason),
    };
  }

  private async playLine(
    pcm: Int16Array,
    text: string | null,
    source: TranscriptSource,
    language: string | null,
  ): Promise<PlaybackResult> {
    if (this.endedFlag) return { completed: false, playedMs: 0 };
    const startMs = this.answeredAt === null ? 0 : this.deps.clock.now() - this.answeredAt;
    if (text) {
      this.botLine = { text, startMs, source };
      this.deps.leg.notify({
        type: 'call.transcript',
        seq: this.seqTranscript + 1,
        speaker: 'bot',
        text,
        final: false,
      });
    }
    const result = await this.deps.leg.play(pcm);
    if (text) {
      this.botLine = null;
      this.transcript('bot', text, {
        source,
        language,
        startMs,
        endMs: startMs + result.playedMs,
        interrupted: !result.completed,
      });
    }
    return result;
  }

  private openStream(source: TranscriptSource): BotStream {
    const { leg, clock } = this.deps;
    const frame = (leg.rate * CALL_LIMITS.frameMs) / 1000;
    const startMs = this.answeredAt === null ? 0 : clock.now() - this.answeredAt;
    const line = { text: '', startMs, source };
    let carry = new Int16Array(0);
    let playedMs = 0;
    let cut = false;
    const plays: Promise<void>[] = [];
    const send = (pcm: Int16Array) => {
      plays.push(
        leg.play(pcm).then((r) => {
          playedMs += r.playedMs;
          if (!r.completed) cut = true;
        }),
      );
    };
    this.botLine = line;
    return {
      push: (pcm) => {
        if (this.endedFlag || cut) return;
        const all = new Int16Array(carry.length + pcm.length);
        all.set(carry);
        all.set(pcm, carry.length);
        const whole = all.length - (all.length % frame);
        carry = all.slice(whole);
        if (whole > 0) send(all.subarray(0, whole));
      },
      finish: async (text, language = null) => {
        if (carry.length && !cut && !this.endedFlag) send(carry);
        carry = new Int16Array(0);
        await Promise.all(plays);
        if (this.botLine === line) this.botLine = null;
        if (text) {
          this.transcript('bot', text, {
            source,
            language,
            startMs,
            endMs: startMs + playedMs,
            interrupted: cut,
          });
        }
        return { completed: !cut, playedMs };
      },
    };
  }

  private transcript(speaker: TranscriptSpeaker, text: string, options: TranscriptOptions): void {
    this.seqTranscript += 1;
    const seq = this.seqTranscript;
    const now = this.answeredAt === null ? 0 : this.deps.clock.now() - this.answeredAt;
    const doc = {
      accountId: this.deps.call.accountId,
      callId: this.deps.call._id,
      seq,
      speaker,
      text: text.slice(0, 4000),
      language: options.language ?? null,
      startMs: Math.max(0, options.startMs ?? now),
      endMs: Math.max(0, options.endMs ?? now),
      interrupted: options.interrupted ?? false,
      source: options.source,
    };
    this.queueWrite(() => TranscriptTurnModel.create(doc));
    const payload = { callId: this.callId, seq, speaker, text: doc.text, final: true };
    // the tester marks a cut line from this flag (the barge-in event comes before the line)
    this.deps.leg.notify({ type: 'call.transcript', ...payload, interrupted: doc.interrupted });
    void tryGetRealtime()
      ?.pushToTopic(`call:${this.callId}`, 'call.transcript', payload)
      .catch(() => undefined);
  }

  private event(type: CallEventType, data: Record<string, unknown> = {}): void {
    this.seqEvents += 1;
    const doc = {
      accountId: this.deps.call.accountId,
      callId: this.deps.call._id,
      seq: this.seqEvents,
      type,
      data,
      at: new Date(this.deps.clock.now()),
    };
    this.queueWrite(() => CallEventModel.create(doc));
    this.deps.leg.notify({ type: 'call.event', event: { type, data, seq: doc.seq } });
  }

  private queueWrite(work: () => Promise<unknown>): void {
    this.writes = this.writes
      .then(work)
      .catch((err: unknown) =>
        this.deps.logger.warn({ err, callId: this.callId }, 'call: write failed'),
      );
  }

  private async setStatus(status: CallStatus, extra: Record<string, unknown>): Promise<void> {
    await CallModel.updateOne({ _id: this.deps.call._id }, { $set: { status, ...extra } });
    this.event('status', { status });
    notifyAccount(this.accountId, 'call.status', {
      callId: this.callId,
      status,
      provider: this.deps.call.provider,
    });
  }

  /** Ends the call once (any caller); resolves with the summary. */
  end(reason: CallEndReason): Promise<CallEndedSummary> {
    this.endPromise ??= this.finish(reason);
    return this.endPromise;
  }

  private async finish(reason: CallEndReason): Promise<CallEndedSummary> {
    this.endedFlag = true;
    const { clock, leg, logger, billing } = this.deps;
    for (const t of this.timers) clock.clearTimeout(t);
    for (const i of this.intervals) clock.clearInterval(i);
    await this.deps.script.stop(reason).catch((err: unknown) => {
      logger.warn({ err, callId: this.callId }, 'call: script stop failed');
    });
    const answered = this.answeredAt !== null;
    const endedAt = clock.now();
    const durationSec = answered
      ? Math.max(0, Math.round((endedAt - (this.answeredAt as number)) / 1000))
      : 0;
    const result = this.deps.script.result();
    this.metrics.latency = this.latency.summary();
    this.metrics.aiSeconds = result.aiSeconds;

    let recording: CallRecording | null = null;
    if (this.recorder) {
      try {
        const closed = await this.recorder.close();
        if (this.deps.storage) {
          recording = await uploadRecording(this.deps.storage, {
            accountId: this.accountId,
            callId: this.callId,
            file: this.recorder.file,
            durationMs: closed.durationMs,
          });
          this.event('recording_saved', {
            durationSec: recording.durationSec,
            sizeBytes: recording.sizeBytes,
          });
        }
      } catch (err) {
        logger.warn({ err, callId: this.callId }, 'call: recording upload failed');
        this.event('recording_failed', { stage: 'upload' });
      }
    }

    let cost: CallCost = emptyCallCost();
    let ledgerEntryId: string | null = null;
    try {
      if (answered) {
        const settled = await billing.settle({
          answered: true,
          durationSec,
          aiSeconds: Math.round(result.aiSeconds),
          ttsChars: this.metrics.ttsChars,
        });
        cost = settled.cost;
        ledgerEntryId = settled.ledgerEntryId;
      } else {
        await billing.release(reason === 'canceled' ? 'canceled' : 'not_answered');
      }
    } catch (err) {
      logger.error({ err, callId: this.callId }, 'call: billing at the end failed');
      this.event('error', { code: 'billing_failed' });
    }

    const status = finalStatus(reason, answered);
    await leg.hangup(LEG_CAUSE[reason] ?? 'normal', {
      type: 'call.ended',
      reason,
      durationSec,
      costMicros: cost.totalMicros,
    });
    this.event('status', { status, endReason: reason });
    await this.writes;
    await CallModel.updateOne(
      { _id: this.deps.call._id },
      {
        $set: {
          status,
          endReason: reason,
          'timestamps.endedAt': new Date(endedAt),
          durationSec,
          outcome: result.outcome,
          disposition: result.disposition,
          variables: result.variables,
          languageDetected: result.languageDetected,
          metrics: this.metrics,
          cost,
          ledgerEntryId,
          recording,
          flowRunId: result.flowRunId,
          seq: { events: this.seqEvents, transcript: this.seqTranscript },
          ...(status === 'failed' ? { error: { code: reason } } : {}),
        },
      },
    );
    await this.deps.registry.unregister(this.callId, this.accountId).catch(() => undefined);
    const summary: CallEndedSummary = {
      callId: this.callId,
      accountId: this.accountId,
      status,
      endReason: reason,
      durationSec,
      costMicros: cost.totalMicros,
      disposition: result.disposition,
      outcome: result.outcome,
    };
    notifyAccount(this.accountId, 'call.status', {
      callId: this.callId,
      status,
      provider: this.deps.call.provider,
    });
    notifyAccount(this.accountId, 'call.ended', {
      callId: this.callId,
      provider: this.deps.call.provider,
      ...(this.deps.call.campaignId ? { campaignId: this.deps.call.campaignId.toString() } : {}),
      status,
      endReason: reason,
      durationSec,
      disposition: result.disposition,
      costMicros: cost.totalMicros,
    });
    logger.info(
      { callId: this.callId, accountId: this.accountId, status, endReason: reason, durationSec },
      'call: ended',
    );
    this.deps.onEnded?.(summary);
    return summary;
  }
}
