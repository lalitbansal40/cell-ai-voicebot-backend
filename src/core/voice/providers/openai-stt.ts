import { encodeMulaw } from '../audio/g711';
import { toBytes } from '../audio/pcm';

import { TypedEmitter } from './emitter';
import { openSocket, realtimeUrl, type RealtimeDeps } from './openai-realtime';
import { parseRealtimeEvent } from './realtime-events';
import type { SocketLike, SttEvents, SttProvider, SttSession } from './types';

/** OpenAI Realtime transcription session (server VAD, final transcripts only). */
export class OpenAiSttSession extends TypedEmitter<SttEvents> implements SttSession {
  private closed = false;

  constructor(
    private readonly socket: SocketLike,
    private readonly rate: 24_000 | 8_000,
  ) {
    super();
    socket.on('message', (data) => {
      const event = parseRealtimeEvent(data);
      if (event?.type === 'input_audio_buffer.speech_started') this.emit('speech_started');
      else if (event?.type === 'input_audio_buffer.speech_stopped') this.emit('speech_stopped');
      else if (event?.type === 'conversation.item.input_audio_transcription.completed') {
        this.emit('final', { text: event.transcript, language: event.language ?? null });
      } else if (event?.type === 'error') {
        this.emit('error', { code: event.error.code ?? 'provider_error', fatal: false });
      }
    });
    socket.on('close', () => {
      if (!this.closed) this.emit('error', { code: 'provider_closed', fatal: true });
      this.closed = true;
    });
    socket.on('error', () => this.emit('error', { code: 'provider_socket_error', fatal: false }));
  }

  sendAudio(pcm: Int16Array): void {
    const bytes = this.rate === 24_000 ? toBytes(pcm) : Buffer.from(encodeMulaw(pcm));
    if (!this.closed) {
      this.socket.send(
        JSON.stringify({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') }),
      );
    }
  }

  /** Typed words count as a finished utterance (dev / tests). */
  sendText(text: string): void {
    this.emit('speech_started');
    this.emit('speech_stopped');
    this.emit('final', { text, language: null });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.socket.close(1000);
    }
    this.removeAll();
    return Promise.resolve();
  }
}

export class OpenAiStt implements SttProvider {
  readonly name = 'openai' as const;

  constructor(private readonly deps: RealtimeDeps) {}

  async open(options: { language: string | null; rate: 24_000 | 8_000 }): Promise<SttSession> {
    const socket = await openSocket(
      realtimeUrl(this.deps.baseUrl, this.deps.model, 'transcription'),
      this.deps,
    );
    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format:
                options.rate === 24_000
                  ? { type: 'audio/pcm', rate: 24_000 }
                  : { type: 'audio/pcmu' },
              transcription: {
                model: this.deps.transcribeModel,
                ...(options.language ? { language: options.language } : {}),
              },
              turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
            },
          },
        },
      }),
    );
    return new OpenAiSttSession(socket, options.rate);
  }
}
