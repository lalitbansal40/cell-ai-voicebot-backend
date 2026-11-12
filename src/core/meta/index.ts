import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import type { Logger } from '../../shared/logger';

import { createFakePinnacleClient } from './fake-pinnacle';
import { createFakeMetaClient, type FakeMetaClient } from './fake.client';
import { createGraphMetaClient } from './graph.client';
import { createPinnacleClient, type PinnacleClient } from './pinnacle.client';
import type { MetaClient } from './types';

export * from './types';
export * from './errors';
export * from './signature';
export * from './schemas';
export * from './message-schemas';
export * from './template-schemas';
export * from './payloads';
export * from './call-schemas';
export { FAKE_CALL_KNOBS, type FakeCallView } from './fake-calling';
export {
  buildFakeCode,
  createFakeMetaClient,
  FAKE_CREDIT_LINE_ID,
  FAKE_EXISTING_PIN,
  FAKE_INBOX_KNOBS,
  FAKE_TEMPLATE_KNOBS,
  FAKE_TEMPLATE_NAME_KNOBS,
  type FakeTemplate,
  FAKE_META_KNOBS,
  fakeMediaSignature,
  isMonoOggOpus,
  verifyFakeMediaSignature,
  type FakeReadReceipt,
  type FakeSentMessage,
  FAKE_SYSTEM_USER_ID,
  fakeIds,
  fakeSignupSchema,
  type FakeMetaClient,
  type FakeSignup,
} from './fake.client';
export {
  createGraphMetaClient,
  createGraphTransport,
  type GraphMetaClientOptions,
  type GraphTransport,
  type GraphTransportOptions,
} from './graph.client';
export {
  createPinnacleClient,
  PINNACLE_API_VERSION,
  PINNACLE_UNSUPPORTED,
  type PinnacleClient,
  type PinnacleClientOptions,
  type PinnacleExtras,
  type PinnacleUserNumber,
  type PinnacleWebhook,
} from './pinnacle.client';
export {
  createFakePinnacleClient,
  FAKE_PINNACLE_KEY_PREFIXES,
  type FakeManagedNumber,
  type FakePinnacleCall,
  type FakePinnacleClient,
} from './fake-pinnacle';

export type MetaEnv = Pick<
  Env,
  | 'META_PROVIDER'
  | 'META_APP_ID'
  | 'META_APP_SECRET'
  | 'META_GRAPH_VERSION'
  | 'META_GRAPH_BASE_URL'
  | 'META_CREDIT_LINE_ID'
  | 'META_SYSTEM_USER_TOKEN'
  | 'FAKE_META_APP_SECRET'
  | 'FAKE_META_STATUS_DELAYS_MS'
  | 'FAKE_META_TEMPLATE_REVIEW_MS'
  | 'APP_URL'
> &
  /** Phase 12 (optional so older callers / tests keep compiling). */
  Partial<Pick<Env, 'FAKE_META_CALL_DELAYS_MS'>>;

export interface MetaDeps {
  redis: Redis;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Fake state key prefix (tests). */
  prefix?: string;
}

/** The webhook / signed_request secret for the chosen provider. */
export const metaAppSecret = (env: MetaEnv): string =>
  env.META_PROVIDER === 'fake' ? (env.FAKE_META_APP_SECRET ?? '') : (env.META_APP_SECRET ?? '');

/** Client chosen by `META_PROVIDER` (env validation guarantees the keys for `meta`). */
export const createMetaClient = (env: MetaEnv, deps: MetaDeps): MetaClient => {
  if (env.META_PROVIDER === 'fake') {
    return createFakeMetaClient({
      redis: deps.redis,
      appSecret: metaAppSecret(env),
      statusDelaysMs: env.FAKE_META_STATUS_DELAYS_MS,
      templateReviewMs: env.FAKE_META_TEMPLATE_REVIEW_MS,
      callDelaysMs: env.FAKE_META_CALL_DELAYS_MS ?? null,
      mediaBaseUrl: env.APP_URL,
      ...(deps.prefix ? { prefix: deps.prefix } : {}),
    });
  }
  return createGraphMetaClient({
    appId: env.META_APP_ID ?? '',
    appSecret: env.META_APP_SECRET ?? '',
    graphVersion: env.META_GRAPH_VERSION,
    baseUrl: env.META_GRAPH_BASE_URL,
    creditLineId: env.META_CREDIT_LINE_ID,
    systemUserToken: env.META_SYSTEM_USER_TOKEN,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
};

export type PinnacleEnv = Pick<
  Env,
  | 'META_PROVIDER'
  | 'PINNACLE_ENABLED'
  | 'PINNACLE_BASE_URL'
  | 'PINNACLE_VOICE_BASE_URL'
  | 'PINNACLE_TIMEOUT_MS'
>;

/**
 * PN: the Pinnacle client for managed numbers — `null` when `PINNACLE_ENABLED` is off;
 * with the fake Meta provider, the fake Pinnacle wrapping that same fake Meta client.
 */
export const createPinnacleFromEnv = (
  env: PinnacleEnv,
  meta: MetaClient,
  deps: Pick<MetaDeps, 'redis' | 'logger' | 'fetch' | 'prefix'>,
): PinnacleClient | null => {
  if (!env.PINNACLE_ENABLED) return null;
  if (env.META_PROVIDER === 'fake' && meta.provider === 'fake') {
    return createFakePinnacleClient(meta as FakeMetaClient, deps.redis, deps.prefix ?? '');
  }
  return createPinnacleClient({
    baseUrl: env.PINNACLE_BASE_URL,
    voiceBaseUrl: env.PINNACLE_VOICE_BASE_URL,
    timeoutMs: env.PINNACLE_TIMEOUT_MS,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
};
