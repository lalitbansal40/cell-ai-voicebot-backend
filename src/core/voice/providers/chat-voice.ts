import { TypedEmitter } from './emitter';
import type {
  AiVoiceSession,
  ChatTurn,
  SttProvider,
  SttSession,
  TtsProvider,
  VoiceAiProvider,
  VoiceSessionEvents,
  VoiceSessionOptions,
} from './types';

/**
 * Speech → text → agent turn → speech. The fake voice provider (dev / tests /
 * E2E) and the OpenAI "chat" pipeline. Turns run one at a time, in order; tools,
 * knowledge and guardrails run inside the turn function (`runAgentTurn`).
 */
export class ChatVoiceSession extends TypedEmitter<VoiceSessionEvents> implements AiVoiceSession {
  readonly kind = 'chat' as const;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly stt: SttSession,
    private readonly tts: TtsProvider,
    private readonly options: VoiceSessionOptions & { turn: ChatTurn },
  ) {
    super();
    stt.on('speech_started', () => this.emit('speech_started'));
    stt.on('speech_stopped', () => this.emit('speech_stopped'));
    stt.on('final', ({ text, language }) => {
      if (text.trim()) this.hear(text.trim(), language);
    });
    stt.on('error', (e) => this.emit('error', e));
  }

  sendAudio(pcm: Int16Array): void {
    this.stt.sendAudio(pcm);
  }

  sendText(text: string): void {
    this.stt.sendText(text);
  }

  /** Tools already ran inside the turn. */
  submitToolResults(): void {}

  /** The full reply stays in the history (the model can't know where it was cut). */
  truncate(): void {}

  say(text: string): void {
    this.enqueue(() => this.speak(text));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stt.close();
    this.removeAll();
  }

  private hear(text: string, language: string | null): void {
    this.emit('customer_transcript', { text, final: true, language });
    this.enqueue(async () => {
      const result = await this.options.turn(text);
      if (this.closed) return;
      this.emit('turn_done', result);
      await this.speak(result.text);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((err: unknown) => {
      if (!this.closed) {
        this.emit('error', {
          code: err instanceof Error && err.name === 'TtsError' ? 'tts_failed' : 'ai_failed',
          fatal: false,
        });
      }
    });
  }

  private async speak(text: string): Promise<void> {
    if (!text.trim()) {
      this.emit('bot_done');
      return;
    }
    const pcm = await this.tts.synthesize({
      text,
      voice: this.options.voice,
      language: this.options.speechLanguage,
    });
    if (this.closed) return;
    this.emit('bot_audio', pcm);
    this.emit('bot_transcript', { text });
    this.emit('bot_done');
  }
}

/** Voice provider over STT + agent turns + TTS. */
export class ChatVoiceProvider implements VoiceAiProvider {
  readonly pipeline = 'chat' as const;

  constructor(
    readonly name: 'openai' | 'fake',
    private readonly stt: SttProvider,
    private readonly tts: TtsProvider,
  ) {}

  async open(options: VoiceSessionOptions): Promise<ChatVoiceSession> {
    if (!options.turn) throw new Error('The chat voice pipeline needs a turn function');
    const stt = await this.stt.open({ language: options.language, rate: options.rate });
    return new ChatVoiceSession(stt, this.tts, { ...options, turn: options.turn });
  }
}
