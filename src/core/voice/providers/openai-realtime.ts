import { decodeMulaw, encodeMulaw } from '../audio/g711';
import { fromBytes, toBytes } from '../audio/pcm';

import { TypedEmitter } from './emitter';
import { parseRealtimeEvent, usageOf } from './realtime-events';
import type {
  AiVoiceSession,
  SocketFactory,
  SocketLike,
  VoiceSessionEvents,
  VoiceSessionOptions,
} from './types';

export const REALTIME_CONNECT_TIMEOUT_MS = 10_000;

export interface RealtimeDeps {
  apiKey: string;
  /** `https://api.openai.com/v1` → `wss://api.openai.com/v1/realtime`. */
  baseUrl: string;
  model: string;
  transcribeModel: string;
  connect: SocketFactory;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export const realtimeUrl = (baseUrl: string, model: string, intent?: 'transcription'): string => {
  const ws = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const query = intent ? `intent=${intent}` : `model=${encodeURIComponent(model)}`;
  return `${ws}/realtime?${query}`;
};

const audioFormat = (rate: 24_000 | 8_000) =>
  rate === 24_000 ? { type: 'audio/pcm', rate: 24_000 } : { type: 'audio/pcmu' };

/** Opens a socket and waits for `open` (bounded). */
export const openSocket = (
  url: string,
  deps: Pick<RealtimeDeps, 'apiKey' | 'connect' | 'setTimeout' | 'clearTimeout'>,
): Promise<SocketLike> =>
  new Promise((resolve, reject) => {
    const socket = deps.connect(url, { Authorization: `Bearer ${deps.apiKey}` });
    const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    const timer = setT(() => {
      socket.close();
      reject(new Error('realtime_connect_timeout'));
    }, REALTIME_CONNECT_TIMEOUT_MS);
    socket.once('open', () => {
      clearT(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearT(timer);
      reject(err);
    });
  });

/** OpenAI Realtime speech-to-speech session. Tools are run by the caller (controller). */
export class RealtimeVoiceSession
  extends TypedEmitter<VoiceSessionEvents>
  implements AiVoiceSession
{
  readonly kind = 'realtime' as const;
  private currentItem: string | null = null;
  private closed = false;
  /** Server events we ignored (not used / unreadable). */
  ignored = 0;

  constructor(
    private readonly socket: SocketLike,
    private readonly options: VoiceSessionOptions,
  ) {
    super();
    socket.on('message', (data) => this.onMessage(data));
    socket.on('close', () => {
      if (!this.closed) this.emit('error', { code: 'provider_closed', fatal: true });
      this.closed = true;
    });
    socket.on('error', () => this.emit('error', { code: 'provider_socket_error', fatal: false }));
  }

  /** Session configuration sent right after the socket opens. */
  static sessionUpdate(options: VoiceSessionOptions, model: string, transcribeModel: string) {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model,
        output_modalities: ['audio'],
        instructions: options.instructions,
        audio: {
          input: {
            format: audioFormat(options.rate),
            noise_reduction: { type: 'near_field' },
            transcription: {
              model: transcribeModel,
              ...(options.language ? { language: options.language } : {}),
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: options.bargeIn,
            },
          },
          output: { format: audioFormat(options.rate), voice: options.voice },
        },
        tools: options.tools.map((t) => ({ type: 'function', ...t })),
        tool_choice: 'auto',
      },
    };
  }

  sendAudio(pcm: Int16Array): void {
    const bytes = this.options.rate === 24_000 ? toBytes(pcm) : Buffer.from(encodeMulaw(pcm));
    this.send({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
  }

  sendText(text: string): void {
    this.emit('customer_transcript', { text, final: true, language: null });
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.send({ type: 'response.create' });
  }

  submitToolResults(results: { callId: string; output: string }[]): void {
    for (const r of results) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: r.callId, output: r.output },
      });
    }
    this.send({ type: 'response.create' });
  }

  truncate(playedMs: number): void {
    if (!this.currentItem) return;
    this.send({
      type: 'conversation.item.truncate',
      item_id: this.currentItem,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(playedMs)),
    });
    this.currentItem = null;
  }

  say(text: string): void {
    this.send({
      type: 'response.create',
      response: { instructions: `Say exactly this, nothing else: "${text.replace(/"/g, "'")}"` },
    });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.socket.close(1000);
    }
    this.removeAll();
    return Promise.resolve();
  }

  private send(event: Record<string, unknown>): void {
    if (!this.closed) this.socket.send(JSON.stringify(event));
  }

  private onMessage(data: unknown): void {
    const event = parseRealtimeEvent(data);
    if (!event) {
      this.ignored += 1;
      return;
    }
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emit('customer_transcript', {
          text: event.transcript,
          final: true,
          language: event.language ?? null,
        });
        break;
      case 'response.output_audio.delta': {
        this.currentItem = event.item_id;
        const bytes = Buffer.from(event.delta, 'base64');
        this.emit(
          'bot_audio',
          this.options.rate === 24_000 ? fromBytes(bytes) : decodeMulaw(bytes),
        );
        break;
      }
      case 'response.output_audio_transcript.done':
        this.emit('bot_transcript', { text: event.transcript });
        break;
      case 'response.function_call_arguments.done':
        this.emit('tool_call', { callId: event.call_id, name: event.name, args: event.arguments });
        break;
      case 'response.done':
        this.emit('usage', usageOf(event.response.usage));
        this.emit('bot_done');
        break;
      case 'error':
        this.emit('error', {
          code: event.error.code ?? event.error.type ?? 'provider_error',
          fatal: false,
        });
        break;
      default:
        break; // session.created / session.updated
    }
  }
}

/** Connects, configures and returns a Realtime session. */
export const openRealtimeSession = async (
  options: VoiceSessionOptions,
  deps: RealtimeDeps,
): Promise<RealtimeVoiceSession> => {
  const socket = await openSocket(realtimeUrl(deps.baseUrl, deps.model), deps);
  const session = new RealtimeVoiceSession(socket, options);
  socket.send(
    JSON.stringify(RealtimeVoiceSession.sessionUpdate(options, deps.model, deps.transcribeModel)),
  );
  return session;
};
