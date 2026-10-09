import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import type { Env } from '../../config/env';
import type { Logger } from '../../shared/logger';

const VERSION = 'v1';
const DEV_FALLBACK = 'cav-dev-secret-box';

export class SecretBoxError extends Error {
  constructor(message = 'Secret could not be opened') {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * Key for sealing small secrets at rest (agent function headers), derived from
 * ENCRYPTION_KEY with its own label so it never equals the storage-signing key.
 * Non-production without ENCRYPTION_KEY uses a fixed dev key (production
 * requires ENCRYPTION_KEY — env rule).
 */
export const secretBoxKey = (
  env: Pick<Env, 'ENCRYPTION_KEY' | 'NODE_ENV'>,
  logger?: Logger,
): Buffer => {
  if (env.ENCRYPTION_KEY) {
    return createHmac('sha256', Buffer.from(env.ENCRYPTION_KEY, 'base64'))
      .update('secret-box-v1')
      .digest();
  }
  if (env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY is required to seal secrets');
  logger?.warn('secrets: ENCRYPTION_KEY not set — using the insecure development key');
  return createHmac('sha256', DEV_FALLBACK).update('secret-box-v1').digest();
};

/** AES-256-GCM → `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export const seal = (key: Buffer, plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join(':');
};

/** Opens a sealed value; throws `SecretBoxError` on tampering, a wrong key or an unknown format. */
export const open = (key: Buffer, sealed: string): string => {
  const [version, iv, tag, data, extra] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined || extra !== undefined) {
    throw new SecretBoxError('Unknown secret format');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new SecretBoxError();
  }
};

/** `••••1234` — what the API shows instead of a secret (computed when sealing). */
export const secretHint = (plain: string): string => `••••${plain.slice(-4)}`;
