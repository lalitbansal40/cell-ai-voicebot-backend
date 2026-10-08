import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { getAuthSecrets } from './secrets';

/** HMAC-SHA256 (hex) with the refresh secret — refresh tokens, reset / invite tokens, OTPs. */
export const hmacToken = (raw: string): string =>
  createHmac('sha256', getAuthSecrets().refresh).update(raw).digest('hex');

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Constant-time comparison of two hex strings. */
export const safeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/** URL-safe random token (default 32 bytes = 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** 6-digit numeric OTP (leading zeros kept). */
export const randomOtp = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');
