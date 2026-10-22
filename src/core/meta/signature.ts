import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

const safeEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** `sha256=<hex HMAC-SHA256(secret, rawBody)>` — the `X-Hub-Signature-256` value Meta sends. */
export const signWebhook = (rawBody: Buffer | string, secret: string): string =>
  `${PREFIX}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

/** Constant-time check of `X-Hub-Signature-256` against the raw request bytes. */
export const verifyWebhookSignature = (
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean => {
  if (!header?.startsWith(PREFIX) || !secret) return false;
  const given = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return safeEqual(Buffer.from(given.toLowerCase(), 'hex'), expected);
};

/** Constant-time string compare (verify token). */
export const safeEqualString = (a: string, b: string): boolean =>
  safeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export type SignedRequestError = 'bad_format' | 'bad_signature' | 'bad_algorithm' | 'expired';

export class SignedRequestInvalid extends Error {
  constructor(readonly reason: SignedRequestError) {
    super(`signed_request invalid (${reason})`);
    this.name = 'SignedRequestInvalid';
  }
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const fromBase64Url = (value: string): Buffer => {
  if (!B64URL.test(value)) throw new SignedRequestInvalid('bad_format');
  return Buffer.from(value.replace(/=+$/, ''), 'base64url');
};

/** `<base64url signature>.<base64url payload>` for tests / the simulator. */
export const buildSignedRequest = (payload: Record<string, unknown>, secret: string): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
};

/**
 * Parses a Meta `signed_request` (deauthorize / data deletion callbacks): HMAC-SHA256
 * of the payload part with the app secret (constant time), `algorithm` HMAC-SHA256,
 * `issued_at` within `maxAgeSec`. Throws `SignedRequestInvalid`.
 */
export const parseSignedRequest = (
  value: string,
  secret: string,
  nowSec: number,
  maxAgeSec: number,
): { userId: string; issuedAt: number } => {
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new SignedRequestInvalid('bad_format');
  const [sigPart, payloadPart] = parts as [string, string];
  const sig = fromBase64Url(sigPart);
  const payloadBytes = fromBase64Url(payloadPart);
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  if (!secret || !safeEqual(sig, expected)) throw new SignedRequestInvalid('bad_signature');
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new SignedRequestInvalid('bad_format');
  }
  if (!payload || typeof payload !== 'object') throw new SignedRequestInvalid('bad_format');
  const { algorithm, user_id: userId, issued_at: issuedAt } = payload as Record<string, unknown>;
  if (typeof algorithm !== 'string' || algorithm.toUpperCase() !== 'HMAC-SHA256') {
    throw new SignedRequestInvalid('bad_algorithm');
  }
  if (
    (typeof userId !== 'string' && typeof userId !== 'number') ||
    String(userId) === '' ||
    typeof issuedAt !== 'number'
  ) {
    throw new SignedRequestInvalid('bad_format');
  }
  if (issuedAt > nowSec + 300 || nowSec - issuedAt > maxAgeSec) {
    throw new SignedRequestInvalid('expired');
  }
  return { userId: String(userId), issuedAt };
};
