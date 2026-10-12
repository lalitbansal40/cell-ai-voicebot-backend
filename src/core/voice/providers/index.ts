import { WebSocket } from 'ws';

import type { Env } from '../../../config/env';

import { ChatVoiceProvider } from './chat-voice';
import { FakeStt } from './fake-stt';
import { FakeTts } from './fake-tts';
import { openRealtimeSession, type RealtimeDeps } from './openai-realtime';
import { OpenAiStt } from './openai-stt';
import { OpenAiTts } from './openai-tts';
import type {
  FetchLike,
  SocketFactory,
  SttProvider,
  TtsProvider,
  VoiceAiProvider,
  VoiceSessionOptions,
} from './types';

export * from './chat-voice';
export * from './emitter';
export * from './fake-stt';
export * from './fake-tts';
export * from './openai-realtime';
export * from './openai-stt';
export * from './openai-tts';
export * from './realtime-events';
export * from './types';

export interface VoiceProviders {
  name: 'openai' | 'fake';
  ai: VoiceAiProvider;
  tts: TtsProvider;
  stt: SttProvider;
  /** `call.say_text` allowed (dev / tests only). */
  textInput: boolean;
}

export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers });

/** Realtime with one connect retry at session start (never mid-call). */
export class RealtimeVoiceProvider implements VoiceAiProvider {
  readonly name = 'openai' as const;
  readonly pipeline = 'realtime' as const;

  constructor(private readonly deps: RealtimeDeps) {}

  async open(options: VoiceSessionOptions) {
    try {
      return await openRealtimeSession(options, this.deps);
    } catch {
      return openRealtimeSession(options, this.deps);
    }
  }
}

export const createVoiceProviders = (
  env: Pick<
    Env,
    | 'VOICE_PROVIDER'
    | 'VOICE_PIPELINE'
    | 'VOICE_TEXT_INPUT_ENABLED'
    | 'OPENAI_API_KEY'
    | 'OPENAI_BASE_URL'
    | 'OPENAI_REALTIME_MODEL'
    | 'OPENAI_TTS_MODEL'
    | 'OPENAI_TRANSCRIBE_MODEL'
  >,
  deps: { fetch?: FetchLike; connect?: SocketFactory } = {},
): VoiceProviders => {
  if (env.VOICE_PROVIDER === 'fake') {
    const tts = new FakeTts();
    const stt = new FakeStt();
    return {
      name: 'fake',
      ai: new ChatVoiceProvider('fake', stt, tts),
      tts,
      stt,
      textInput: env.VOICE_TEXT_INPUT_ENABLED,
    };
  }
  const realtime: RealtimeDeps = {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_REALTIME_MODEL,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
    connect: deps.connect ?? defaultSocketFactory,
  };
  const tts = new OpenAiTts({
    apiKey: realtime.apiKey,
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_TTS_MODEL,
    fetch: deps.fetch ?? fetch,
  });
  const stt = new OpenAiStt(realtime);
  return {
    name: 'openai',
    ai:
      env.VOICE_PIPELINE === 'chat'
        ? new ChatVoiceProvider('openai', stt, tts)
        : new RealtimeVoiceProvider(realtime),
    tts,
    stt,
    textInput: env.VOICE_TEXT_INPUT_ENABLED,
  };
};
