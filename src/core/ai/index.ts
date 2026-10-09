import type { Env } from '../../config/env';

import { createFakeProvider } from './fake.provider';
import { createOpenAiProvider } from './openai.provider';
import type { AiProvider } from './types';

export * from './types';
export { createFakeProvider, fakeEmbedding, FAKE_RULES } from './fake.provider';
export { createOpenAiProvider } from './openai.provider';

/** The AI provider chosen by env (`AI_PROVIDER`; production requires openai — env rule). */
export const createAiProvider = (
  env: Pick<Env, 'AI_PROVIDER' | 'OPENAI_API_KEY' | 'OPENAI_BASE_URL'>,
): AiProvider =>
  env.AI_PROVIDER === 'openai'
    ? createOpenAiProvider({ apiKey: env.OPENAI_API_KEY ?? '', baseUrl: env.OPENAI_BASE_URL })
    : createFakeProvider();
