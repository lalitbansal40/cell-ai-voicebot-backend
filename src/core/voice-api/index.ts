import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';

import { Cell24x7VoiceClient } from './cell24x7.client';
import { FakeVoiceClient } from './fake.client';
import type { VoiceApiClient } from './types';

export * from './types';
export { Cell24x7VoiceClient } from './cell24x7.client';
export { FakeVoiceClient } from './fake.client';

export type VoiceApiEnv = Pick<
  Env,
  | 'NODE_ENV'
  | 'VOICE_API_PROVIDER'
  | 'CELL24X7_VOICE_BASE_URL'
  | 'CELL24X7_VOICE_API_TOKEN'
  | 'VOICE_API_FAKE_DELAY_MS'
>;

/** Optional shared platform login; account API keys work independently when this is `null`. */
export const createVoiceApiClient = (
  env: VoiceApiEnv,
  deps: { redis: Redis; prefix?: string },
): VoiceApiClient | null => {
  if (env.VOICE_API_PROVIDER === 'off') return null;
  if (env.VOICE_API_PROVIDER === 'fake') {
    if (env.NODE_ENV === 'production') throw new Error('fake voice provider in production');
    return new FakeVoiceClient(deps.redis, {
      delayMs: env.VOICE_API_FAKE_DELAY_MS,
      ...(deps.prefix ? { prefix: deps.prefix } : {}),
    });
  }
  return new Cell24x7VoiceClient({
    baseUrl: env.CELL24X7_VOICE_BASE_URL,
    token: env.CELL24X7_VOICE_API_TOKEN ?? '',
  });
};

let current: VoiceApiClient | null = null;

/** Process-wide shared platform client (set by the server; tests set their own). */
export const setVoiceApiClient = (client: VoiceApiClient | null): void => {
  current = client;
};

export const getVoiceApiClient = (): VoiceApiClient | null => current;
