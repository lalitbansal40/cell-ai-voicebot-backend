import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Receivers reject timestamps further than this from their clock (replay window). */
export const SIGNATURE_TOLERANCE_SEC = 300;
export const SECRET_PREFIX = 'whsec_';

/** A new signing secret: 32 random bytes, shown once as `whsec_<base64url>`. */
export const newWebhookSecret = (): string =>
  `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;

/**
 * `hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))` — the key is the whole secret
 * string as shown (`whsec_…`), the body the exact bytes sent.
 */
export const sign = (secret: string, timestamp: number, rawBody: string | Buffer): string =>
  createHmac('sha256', secret)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest('hex');

/** `X-Webhook-Signature`: `v1=<current>` plus `, v1=<previous>` during a rotation. */
export const signatureHeader = (
  secrets: readonly string[],
  timestamp: number,
  rawBody: string | Buffer,
): string => secrets.map((s) => `v1=${sign(s, timestamp, rawBody)}`).join(', ');

const safeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

/**
 * Receiver-side check (also used by the dev receiver and tests): any `v1=` value
 * matches any of `secrets` (constant time), and the timestamp is within the window.
 */
export const verify = (
  header: string | undefined,
  secrets: readonly string[],
  timestamp: string | number | undefined,
  rawBody: string | Buffer,
  {
    toleranceSec = SIGNATURE_TOLERANCE_SEC,
    now = Date.now(),
  }: { toleranceSec?: number; now?: number } = {},
): boolean => {
  if (!header || timestamp === undefined) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Math.floor(now / 1000) - ts) > toleranceSec) return false;
  const given = header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  return secrets.some((secret) => {
    const expected = sign(secret, ts, rawBody);
    return given.some((g) => safeEqualHex(g, expected));
  });
};
