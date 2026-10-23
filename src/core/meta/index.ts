import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import type { Logger } from '../../shared/logger';

import { createFakeMetaClient } from './fake.client';
import { createGraphMetaClient } from './graph.client';
import type { MetaClient } from './types';

export * from './types';
export * from './errors';
export * from './signature';
export * from './schemas';
export * from './message-schemas';
export * from './template-schemas';
export * from './payloads';
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
export { createGraphMetaClient, type GraphMetaClientOptions } from './graph.client';

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
>;

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
