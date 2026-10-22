import { MetaApiError } from './types';

/** Graph error codes worth retrying (transient / rate limits). */
export const RETRYABLE_GRAPH_CODES: ReadonlySet<number> = new Set([1, 2, 4, 17, 32, 613, 80007]);
/** `OAuthException` subcodes that mean the token is gone (expired, password change, removed). */
export const TOKEN_INVALID_SUBCODES: ReadonlySet<number> = new Set([460, 463, 467]);

/** Well-known Graph codes the WhatsApp service reacts to. */
export const META_ERROR_CODES = {
  tokenInvalid: 190,
  /** Two-step verification PIN mismatch / already set (register). */
  pinMismatch: 133005,
  /** Authorization code expired / invalid. */
  codeExpired: 36007,
  /** Authorization code already used. */
  codeUsed: 36009,
} as const;

const SECRET_PATTERNS: RegExp[] = [
  /access_token=[^&\s"]+/g,
  /client_secret=[^&\s"]+/g,
  /input_token=[^&\s"]+/g,
  /code=[^&\s"]+/g,
  /Bearer\s+[^\s"]+/gi,
];

/** Removes credentials Meta may echo in error messages / URLs. */
export const scrubSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce(
    (out, re) =>
      out.replace(re, (match) =>
        /^bearer/i.test(match) ? 'Bearer ***' : `${match.slice(0, match.indexOf('=') + 1)}***`,
      ),
    text,
  ).slice(0, 500);

interface GraphErrorBody {
  message?: unknown;
  type?: unknown;
  code?: unknown;
  error_subcode?: unknown;
  fbtrace_id?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const isTokenInvalid = (code: number | null, subcode: number | null, type: string | null) =>
  code === META_ERROR_CODES.tokenInvalid ||
  (type === 'OAuthException' && subcode !== null && TOKEN_INVALID_SUBCODES.has(subcode));

/** Builds a `MetaApiError` from a Graph error body (`{ error: { … } }`) and the HTTP status. */
export const graphError = (status: number, body: unknown): MetaApiError => {
  const err =
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object'
      ? (body.error as GraphErrorBody)
      : {};
  const code = num(err.code);
  const subcode = num(err.error_subcode);
  const type = str(err.type);
  return new MetaApiError({
    status,
    code,
    subcode,
    type,
    message: scrubSecrets(str(err.message) ?? `Meta request failed (HTTP ${String(status)})`),
    fbtraceId: str(err.fbtrace_id),
    retryable: status >= 500 || (code !== null && RETRYABLE_GRAPH_CODES.has(code)),
    tokenInvalid: isTokenInvalid(code, subcode, type),
  });
};

/** Network error / timeout (no HTTP response) — always retryable. */
export const networkError = (timedOut: boolean): MetaApiError =>
  new MetaApiError({
    status: 0,
    code: null,
    subcode: null,
    type: timedOut ? 'timeout' : 'network',
    message: timedOut ? 'Meta did not answer in time' : 'Meta is not reachable',
    fbtraceId: null,
    retryable: true,
    tokenInvalid: false,
  });

/** A 2xx answer that isn't JSON or doesn't match the expected shape. */
export const invalidResponse = (status: number, what: string): MetaApiError =>
  new MetaApiError({
    status,
    code: null,
    subcode: null,
    type: 'invalid_response',
    message: `Unexpected Meta response (${what})`,
    fbtraceId: null,
    retryable: status >= 500,
    tokenInvalid: false,
  });

/** A call our side can't make yet (credit line id / System User token missing). */
export const notConfigured = (what: string): MetaApiError =>
  new MetaApiError({
    status: 0,
    code: null,
    subcode: null,
    type: 'not_configured',
    message: `${what} is not configured on this server`,
    fbtraceId: null,
    retryable: false,
    tokenInvalid: false,
  });

/** Safe fields for logs / error details (never tokens, URLs or bodies). */
export const metaErrorMeta = (err: MetaApiError) => ({
  status: err.status,
  code: err.code,
  subcode: err.subcode,
  type: err.type,
  fbtraceId: err.fbtraceId,
});
