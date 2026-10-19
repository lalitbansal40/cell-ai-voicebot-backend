import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import { createFakeProvider } from '../../core/ai/fake.provider';
import { outgoingPolicy } from '../../core/ai/ip-guard';
import { secretBoxKey } from '../../core/ai/secret-box';
import type { StorageProvider } from '../../core/storage';
import { AiVoiceController } from '../../core/voice/ai-session';
import { createVoiceProviders } from '../../core/voice/providers';
import { passThroughTts, type TtsCache } from '../../core/voice/tts-cache';

import { createScriptFactory, type ScriptFactory } from './scripts';

export interface DryRunPrograms {
  /** Always `fake` — dry runs never spend on OpenAI, whatever the env says. */
  voiceName: string;
  tts: Pick<TtsCache, 'get'>;
  scriptFor: ScriptFactory;
}

/**
 * Programs of dry-run calls (PHASE_8_PROMPT §1 "Dry-run provider"): the fake
 * voice (chat pipeline) and the fake AI model, TTS without the storage cache,
 * and no AI charges / wallet gates (the call is priced virtually at the end).
 */
export const createDryRunPrograms = (deps: {
  env: Env;
  storage: StorageProvider | undefined;
  redis?: Redis;
}): DryRunPrograms => {
  const { env } = deps;
  const voice = createVoiceProviders({ ...env, VOICE_PROVIDER: 'fake', VOICE_PIPELINE: 'chat' });
  const ai = createFakeProvider();
  return {
    voiceName: voice.name,
    tts: passThroughTts(voice.tts),
    scriptFor: createScriptFactory({
      env,
      secretKey: secretBoxKey(env),
      provider: ai,
      stt: voice.stt,
      storage: deps.storage,
      ...(deps.redis ? { redis: deps.redis } : {}),
      billing: 'none',
      controller: new AiVoiceController({
        voice: voice.ai,
        ai,
        embeddingModel: env.OPENAI_EMBEDDING_MODEL,
        secretKey: secretBoxKey(env),
        http: { policy: outgoingPolicy(env) },
        billing: 'none',
      }),
    }),
  };
};
