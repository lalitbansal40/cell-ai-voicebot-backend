import type { Env } from '../../config/env';
import type { Logger } from '../../shared/logger';

import { LocalStorage } from './local.storage';
import { S3Storage } from './s3.storage';
import { signingKey } from './signing';
import type { StorageProvider } from './storage.types';

export * from './keys';
export * from './storage.types';
export { LocalStorage } from './local.storage';
export { S3Storage } from './s3.storage';
export { signingKey, signPath, verifySignature } from './signing';

/** Picks the driver from STORAGE_DRIVER. */
export const createStorage = (env: Env, logger?: Logger): StorageProvider =>
  env.STORAGE_DRIVER === 's3'
    ? S3Storage.fromEnv(env)
    : new LocalStorage(env.STORAGE_LOCAL_PATH, env.APP_URL, signingKey(env, logger));
