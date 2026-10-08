import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

import WebSocket from 'ws';

import {
  bufferToPcm16,
  decodeMulaw,
  encodeMulaw,
  pcm16ToBuffer,
  SAMPLE_RATE_PHONE,
  SAMPLE_RATE_REALTIME,
  type Pcm16,
} from './audio.ts';
import { REALTIME_URL, requireApiKey, TRANSCRIBE_MODEL } from './config.ts';
import { ClientEvent, ServerEvent } from './events.ts';
import { realtimeCostUsd, type RealtimeUsage } from './pricing.ts';

/** `pcm24k` = studio-quality PCM16 24 kHz; `g711_ulaw` = phone-like G.711 μ-law 8 kHz. */
export type AudioMode = 'pcm24k' | 'g711_ulaw';

export const modeRate = (mode: AudioMode): number =>
  mode === 'pcm24k' ? SAMPLE_RATE_REALTIME : SAMPLE_RATE_PHONE;

export interface SessionOptions {
  model: string;
  voice: string;
  mode: AudioMode;
  instructions: string;
  tools: readonly unknown[];
  vad?: {
    threshold?: number;
    prefixPaddingMs?: number;
    silenceDurationMs?: number;
    idleTimeoutMs?: number;
  };
  transcribeModel?: string;
}

export interface LoggedEvent {
  t: number; // ms since session start
  type: string;
  [key: string]: unknown;
}

export interface ResponseRecord {
  id: string;
  createdAt: number;
  firstAudioAt?: number;
  audio: Pcm16[];
  audioSamples: number;
  transcript: string;
  status?: string;
  usage?: RealtimeUsage;
  costUsd: number;
  functionCalls: { callId: string; name: string; arguments: string }[];
  itemId?: string;
}

type ServerMessage = { type: string; [key: string]: unknown };

const formatFor = (mode: AudioMode) =>
  mode === 'pcm24k' ? { type: 'audio/pcm', rate: SAMPLE_RATE_REALTIME } : { type: 'audio/pcmu' };

/** Thin wrapper over the OpenAI Realtime WebSocket with timing + cost bookkeeping. */
export class RealtimeSession extends EventEmitter {
  readonly log: LoggedEvent[] = [];
  readonly responses = new Map<string, ResponseRecord>();
  readonly customerTranscripts: { t: number; itemId: string; transcript: string }[] = [];
  readonly speechStarted: number[] = [];
  readonly speechStopped: number[] = [];
  readonly errors: ServerMessage[] = [];
  costUsd = 0;

  private readonly t0 = performance.now();
  private constructor(
    private readonly ws: WebSocket,
    readonly options: SessionOptions,
  ) {
    super();
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', () => this.emit('closed'));
  }

  now(): number {
    return performance.now() - this.t0;
  }

  static async connect(options: SessionOptions): Promise<RealtimeSession> {
    const ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(options.model)}`, {
      headers: { Authorization: `Bearer ${requireApiKey()}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const session = new RealtimeSession(ws, options);
    session.send({
      type: ClientEvent.SessionUpdate,
      session: {
        type: 'realtime',
        model: options.model,
        output_modalities: ['audio'],
        instructions: options.instructions,
        audio: {
          input: {
            format: formatFor(options.mode),
            noise_reduction: { type: 'near_field' },
            transcription: { model: options.transcribeModel ?? TRANSCRIBE_MODEL },
            turn_detection: {
              type: 'server_vad',
              threshold: options.vad?.threshold ?? 0.5,
              prefix_padding_ms: options.vad?.prefixPaddingMs ?? 300,
              silence_duration_ms: options.vad?.silenceDurationMs ?? 500,
              create_response: true,
              interrupt_response: true,
              ...(options.vad?.idleTimeoutMs ? { idle_timeout_ms: options.vad.idleTimeoutMs } : {}),
            },
          },
          output: { format: formatFor(options.mode), voice: options.voice },
        },
        tools: options.tools,
        tool_choice: 'auto',
      },
    });
    await session.waitFor(ServerEvent.SessionUpdated, () => true, 15_000);
    return session;
  }

  send(event: Record<string, unknown>): void {
    const { audio: _audio, ...meta } = event;
    this.log.push({ t: this.now(), dir: 'out', ...meta, type: String(event.type) });
    this.ws.send(JSON.stringify(event));
  }

  /** Append one frame (PCM16 at the session's mode rate). */
  appendAudio(frame: Pcm16): void {
    const bytes = this.options.mode === 'pcm24k' ? pcm16ToBuffer(frame) : encodeMulaw(frame);
    this.ws.send(
      JSON.stringify({ type: ClientEvent.InputAudioAppend, audio: bytes.toString('base64') }),
    );
  }

  /** Kick off the bot's first turn (opening line) without customer audio. */
  startGreeting(): void {
    this.send({ type: ClientEvent.ResponseCreate });
  }

  /** Adds a function result; call `requestResponse()` once after all outputs are added. */
  sendFunctionOutput(callId: string, output: unknown): void {
    this.send({
      type: ClientEvent.ItemCreate,
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
  }

  requestResponse(): void {
    this.send({ type: ClientEvent.ResponseCreate });
  }

  truncate(itemId: string, audioEndMs: number): void {
    this.send({
      type: ClientEvent.ItemTruncate,
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioEndMs)),
    });
  }

  waitFor(
    type: string,
    predicate: (e: ServerMessage) => boolean = () => true,
    timeoutMs = 30_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('event', handler);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${type}`));
      }, timeoutMs);
      const handler = (e: ServerMessage) => {
        if (e.type === type && predicate(e)) {
          clearTimeout(timer);
          this.off('event', handler);
          resolve(e);
        }
      };
      this.on('event', handler);
    });
  }

  close(): void {
    this.ws.close();
  }

  private record(id: string): ResponseRecord {
    let r = this.responses.get(id);
    if (!r) {
      r = {
        id,
        createdAt: this.now(),
        audio: [],
        audioSamples: 0,
        transcript: '',
        costUsd: 0,
        functionCalls: [],
      };
      this.responses.set(id, r);
    }
    return r;
  }

  private onMessage(raw: string): void {
    const e = JSON.parse(raw) as ServerMessage;
    const t = this.now();
    switch (e.type) {
      case ServerEvent.AudioDelta: {
        const r = this.record(String(e.response_id));
        const bytes = Buffer.from(String(e.delta), 'base64');
        const pcm = this.options.mode === 'pcm24k' ? bufferToPcm16(bytes) : decodeMulaw(bytes);
        r.firstAudioAt ??= t;
        r.itemId ??= String(e.item_id);
        r.audio.push(pcm);
        r.audioSamples += pcm.length;
        this.log.push({ t, type: e.type, responseId: e.response_id, bytes: bytes.length });
        break;
      }
      case ServerEvent.AudioTranscriptDone:
        this.record(String(e.response_id)).transcript = String(e.transcript ?? '');
        this.log.push({ t, type: e.type, responseId: e.response_id, transcript: e.transcript });
        break;
      case ServerEvent.ResponseCreated: {
        const response = e.response as { id: string };
        this.record(response.id);
        this.log.push({ t, type: e.type, responseId: response.id });
        break;
      }
      case ServerEvent.FunctionCallArgumentsDone:
        this.record(String(e.response_id)).functionCalls.push({
          callId: String(e.call_id),
          name: String(e.name),
          arguments: String(e.arguments),
        });
        this.log.push({ t, type: e.type, name: e.name, arguments: e.arguments });
        break;
      case ServerEvent.ResponseDone: {
        const response = e.response as { id: string; status?: string; usage?: RealtimeUsage };
        const r = this.record(response.id);
        r.status = response.status;
        r.usage = response.usage;
        r.costUsd = realtimeCostUsd(this.options.model, response.usage);
        this.costUsd += r.costUsd;
        this.log.push({
          t,
          type: e.type,
          responseId: response.id,
          status: response.status,
          usage: response.usage,
          costUsd: r.costUsd,
        });
        break;
      }
      case ServerEvent.SpeechStarted:
        this.speechStarted.push(t);
        this.log.push({ t, type: e.type, audioStartMs: e.audio_start_ms });
        break;
      case ServerEvent.SpeechStopped:
        this.speechStopped.push(t);
        this.log.push({ t, type: e.type, audioEndMs: e.audio_end_ms });
        break;
      case ServerEvent.InputTranscriptCompleted:
        this.customerTranscripts.push({
          t,
          itemId: String(e.item_id),
          transcript: String(e.transcript ?? ''),
        });
        this.log.push({ t, type: e.type, transcript: e.transcript });
        break;
      case ServerEvent.Error:
        this.errors.push(e);
        this.log.push({ t, type: e.type, error: e.error });
        break;
      default:
        this.log.push({ t, type: e.type });
    }
    this.emit('event', e);
  }
}
