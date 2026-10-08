import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Env } from '../../config/env';
import type { Logger } from '../../shared/logger';

const DEV_FALLBACK = 'cav-dev-insecure-storage-signing-key';

/**
 * HMAC key for local signed URLs, derived from ENCRYPTION_KEY.
 * Non-production without ENCRYPTION_KEY uses a fixed dev key (production requires ENCRYPTION_KEY).
 */
export const signingKey = (
  env: Pick<Env, 'ENCRYPTION_KEY' | 'NODE_ENV'>,
  logger?: Logger,
): Buffer => {
  if (env.ENCRYPTION_KEY) {
    return createHmac('sha256', Buffer.from(env.ENCRYPTION_KEY, 'base64'))
      .update('storage-url-v1')
      .digest();
  }
  if (env.NODE_ENV === 'production')
    throw new Error('ENCRYPTION_KEY is required to sign storage URLs');
  logger?.warn('storage: ENCRYPTION_KEY not set — using the insecure development signing key');
  return createHmac('sha256', DEV_FALLBACK).update('storage-url-v1').digest();
};

export const signPath = (key: Buffer, path: string, exp: number): string =>
  createHmac('sha256', key).update(`${path}\n${exp}`).digest('hex');

/** Timing-safe signature check. */
export const verifySignature = (key: Buffer, path: string, exp: number, sig: string): boolean => {
  const expected = Buffer.from(signPath(key, path, exp), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};
