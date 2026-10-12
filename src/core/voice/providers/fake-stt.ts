import { EnergyVad } from '../audio/vad';

import { TypedEmitter } from './emitter';
import type { SttEvents, SttProvider, SttSession } from './types';

/**
 * Deterministic speech-to-text: words come only from typed text (`sendText`);
 * real microphone audio still drives an energy VAD (speech start / stop, empty text).
 */
export class FakeSttSession extends TypedEmitter<SttEvents> implements SttSession {
  private readonly vad = new EnergyVad();

  sendAudio(pcm: Int16Array): void {
    const event = this.vad.push(pcm);
    if (event === 'started') this.emit('speech_started');
    else if (event === 'stopped') {
      this.emit('speech_stopped');
      this.emit('final', { text: '', language: null });
    }
  }

  sendText(text: string): void {
    this.emit('speech_started');
    this.emit('speech_stopped');
    this.emit('final', { text, language: null });
  }

  close(): Promise<void> {
    this.removeAll();
    return Promise.resolve();
  }
}

export class FakeStt implements SttProvider {
  readonly name = 'fake' as const;

  open(): Promise<SttSession> {
    return Promise.resolve(new FakeSttSession());
  }
}
