import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import type { Env } from '../../config/env';
import type { Logger } from '../logger';

const VERSION_V1 = 'v1';
const VERSION = 'v2';
const DEV_FALLBACK = 'cav-dev-secret-box';

export class SecretBoxError extends Error {
  constructor(message = 'Secret could not be opened') {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** `current` seals; `all` (current first) opens, so old values keep working during a rotation. */
export interface SecretKeys {
  current: Buffer;
  all: Buffer[];
}

/** What `seal` and `open` take. A single Buffer is one key with no older ones. */
export type SecretKey = Buffer | SecretKeys;

const keysOf = (key: SecretKey): SecretKeys =>
  Buffer.isBuffer(key) ? { current: key, all: [key] } : key;

/** First 8 hex characters of the derived key's SHA-256: names the key without revealing it. */
const keyIds = new WeakMap<Buffer, string>();
export const keyIdOf = (key: Buffer): string => {
  let id = keyIds.get(key);
  if (!id) {
    id = createHash('sha256').update(key).digest('hex').slice(0, 8);
    keyIds.set(key, id);
  }
  return id;
};

const derive = (material: Buffer | string): Buffer =>
  createHmac('sha256', material).update('secret-box-v1').digest();

/**
 * Keys for sealing small secrets at rest, derived from ENCRYPTION_KEY with their own label
 * so they never equal the storage-signing key. ENCRYPTION_KEYS_OLD can still open.
 * Non-production without ENCRYPTION_KEY uses a fixed dev key (production requires
 * ENCRYPTION_KEY — env rule).
 */
export const secretKeys = (
  env: Pick<Env, 'ENCRYPTION_KEY' | 'NODE_ENV'> & { ENCRYPTION_KEYS_OLD?: string | undefined },
  logger?: Logger,
): SecretKeys => {
  const old = (env.ENCRYPTION_KEYS_OLD ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
    .map((k) => derive(Buffer.from(k, 'base64')));
  let current: Buffer;
  if (env.ENCRYPTION_KEY) {
    current = derive(Buffer.from(env.ENCRYPTION_KEY, 'base64'));
  } else {
    if (env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required to seal secrets');
    }
    logger?.warn('secrets: ENCRYPTION_KEY not set — using the insecure development key');
    current = derive(DEV_FALLBACK);
  }
  return { current, all: [current, ...old] };
};

/** The name every caller already uses. */
export const secretBoxKey = secretKeys;

/** AES-256-GCM → `v2:<keyId>:<iv>:<tag>:<ciphertext>` (base64 parts). */
export const seal = (key: SecretKey, plain: string): string => {
  const { current } = keysOf(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    VERSION,
    keyIdOf(current),
    ...[iv, cipher.getAuthTag(), data].map((p) => p.toString('base64')),
  ].join(':');
};

const decrypt = (key: Buffer, iv: string, tag: string, data: string): string => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
};

/**
 * Opens a sealed value. v2 names its key; v1 has no name, so each key is tried.
 * Throws `SecretBoxError` on tampering, a missing key or an unknown format.
 */
export const open = (key: SecretKey, sealed: string): string => {
  const { all } = keysOf(key);
  const parts = sealed.split(':');
  if (parts[0] === VERSION && parts.length === 5) {
    const [, keyId, iv, tag, data] = parts as [string, string, string, string, string];
    const match = all.find((k) => keyIdOf(k) === keyId);
    if (!match) throw new SecretBoxError('Secret was sealed with a key that is not configured');
    try {
      return decrypt(match, iv, tag, data);
    } catch {
      throw new SecretBoxError();
    }
  }
  if (parts[0] === VERSION_V1 && parts.length === 4) {
    const [, iv, tag, data] = parts as [string, string, string, string];
    for (const candidate of all) {
      try {
        return decrypt(candidate, iv, tag, data);
      } catch {
        // the next key may fit
      }
    }
    throw new SecretBoxError();
  }
  throw new SecretBoxError('Unknown secret format');
};

/** True when the value is already v2 under the current key (a re-seal leaves it alone). */
export const isSealedWithCurrent = (key: SecretKey, sealed: string): boolean =>
  sealed.startsWith(`${VERSION}:${keyIdOf(keysOf(key).current)}:`);

/** `••••1234` — what the API shows instead of a secret (computed when sealing). */
export const secretHint = (plain: string): string => `••••${plain.slice(-4)}`;
