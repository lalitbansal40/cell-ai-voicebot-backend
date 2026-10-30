/**
 * The logic of `docs/integrations/apps-script-receiver.gs`, in TypeScript so it is
 * tested against the webhook golden vectors (Apps Script can't run in CI). Keep the
 * two in step: same checks, same row columns.
 */

export interface ReceiverInput {
  headers: Record<string, string | undefined>;
  rawBody: string;
  secret: string;
  nowSec: number;
  /** HMAC-SHA256 → hex (Apps Script: `Utilities.computeHmacSha256Signature`). */
  hmacHex: (key: string, message: string) => string;
}

export const ROW_COLUMNS = [
  'Received at',
  'Event id',
  'Call id',
  'External ref',
  'Status',
  'Outcome',
  'Duration (s)',
  'Cost (₹)',
  'Contact id',
] as const;

/** Constant-time string compare (Apps Script has no timingSafeEqual). */
export const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** The Apps Script check: the secret `key` query parameter of the web app URL. */
export const keyMatches = (given: string | undefined, expected: string): boolean =>
  Boolean(expected) && sameText(given ?? '', expected);

/** The documented check (behind a proxy that passes headers): timestamp within 5 min, any `v1=` equal to HMAC(secret, ts + "." + body). */
export const verifyRequest = (input: ReceiverInput): boolean => {
  const ts = Number(input.headers['x-webhook-timestamp']);
  if (!Number.isInteger(ts) || Math.abs(input.nowSec - ts) > 300) return false;
  const expected = input.hmacHex(input.secret, `${String(ts)}.${input.rawBody}`);
  return String(input.headers['x-webhook-signature'] ?? '')
    .split(',')
    .map((p) => p.trim().replace(/^v1=/, ''))
    .some((given) => sameText(given, expected));
};

/** One sheet row for a `call.completed` event; `null` for other events. */
export const rowFor = (rawBody: string, receivedAt: string): (string | number)[] | null => {
  const event = JSON.parse(rawBody) as { id: string; type: string; data: Record<string, unknown> };
  if (event.type !== 'call.completed') return null;
  const d = event.data;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return [
    receivedAt,
    event.id,
    str(d.callId),
    str(d.externalRef),
    str(d.status),
    str(d.disposition),
    num(d.durationSec),
    Math.round(num(d.costMicros) / 10_000) / 100,
    str(d.contactId),
  ];
};
