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
  /** Permission denied, e.g. a WABA field only Business Solution Providers may read. */
  permissionDenied: 10,
} as const;

const SECRET_PATTERNS: RegExp[] = [
  /access_token=[^&\s"]+/g,
  /client_secret=[^&\s"]+/g,
  /input_token=[^&\s"]+/g,
  /code=[^&\s"]+/g,
  /Bearer\s+[^\s"]+/gi,
  /OAuth\s+[^\s"]+/g,
];
/** SDP bodies / ICE credentials / candidates / fingerprints (they carry IPs and keys). */
const SDP_PATTERNS: RegExp[] = [
  /v=0[\s\S]*/g,
  // the rest of the line: a candidate carries the IP / port, a fingerprint its hash after a space
  /a=(?:ice-pwd|ice-ufrag|fingerprint|candidate):[^\r\n"]*/g,
];
/** Media URLs (they authorise a download for a while) are never kept in messages. */
const MEDIA_URL = /https?:\/\/[^\s"]*(?:fbsbx|fbcdn|whatsapp\.net)[^\s"]*/gi;

/** Removes credentials Meta may echo in error messages / URLs. */
export const scrubSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce(
    (out, re) =>
      out.replace(re, (match) =>
        /^bearer/i.test(match)
          ? 'Bearer ***'
          : match.startsWith('OAuth')
            ? 'OAuth ***'
            : `${match.slice(0, match.indexOf('=') + 1)}***`,
      ),
    SDP_PATTERNS.reduce((out, re) => out.replace(re, '<sdp>'), text).replace(
      MEDIA_URL,
      '<media url>',
    ),
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

/** A media download we refuse (not a Meta host / larger than allowed). */
export const mediaRefused = (reason: 'host' | 'too_large'): MetaApiError =>
  new MetaApiError({
    status: 0,
    code: null,
    subcode: null,
    type: reason === 'host' ? 'media_host_refused' : 'media_too_large',
    message: reason === 'host' ? 'Media URL is not a Meta host' : 'Media is larger than allowed',
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

/** What a failed send means for the message and the channel (PHASE_10_PLAN §1d). */
export interface SendErrorMapping {
  retryable: boolean;
  /** Wait at least this long before the next attempt (Meta pair rate limit). */
  retryAfterSec: number | null;
  channelEffect: 'none' | 'needs_reconnect' | 'restricted';
  /** Shown on the bubble — our text, never Meta's (it can quote customer data). */
  reason: string;
}

const SEND_ERRORS: Record<
  number,
  Omit<SendErrorMapping, 'channelEffect'> & {
    channelEffect?: SendErrorMapping['channelEffect'];
  }
> = {
  131047: {
    retryable: false,
    retryAfterSec: null,
    reason: 'More than 24 hours have passed since the customer last replied',
  },
  131026: { retryable: false, retryAfterSec: null, reason: 'Message undeliverable' },
  131049: {
    retryable: false,
    retryAfterSec: null,
    reason: 'WhatsApp limited marketing messages to this customer — try later',
  },
  131050: { retryable: false, retryAfterSec: null, reason: 'Customer stopped marketing messages' },
  // Phase 11 — template sends (Meta error codes reference, re-checked 23 Oct 2026)
  132000: {
    retryable: false,
    retryAfterSec: null,
    reason: "Template variables don't match the template",
  },
  132001: { retryable: false, retryAfterSec: null, reason: 'Template not found for this language' },
  132005: {
    retryable: false,
    retryAfterSec: null,
    reason: 'Text too long after filling the variables',
  },
  132007: {
    retryable: false,
    retryAfterSec: null,
    reason: 'Template content violates WhatsApp policy',
  },
  132012: {
    retryable: false,
    retryAfterSec: null,
    reason: "Variable format doesn't match the template",
  },
  132015: { retryable: false, retryAfterSec: null, reason: 'Template is paused for low quality' },
  132016: { retryable: false, retryAfterSec: null, reason: 'Template is disabled' },
  131051: { retryable: false, retryAfterSec: null, reason: 'Unsupported message type' },
  131052: { retryable: true, retryAfterSec: null, reason: 'Media download error' },
  131053: { retryable: true, retryAfterSec: null, reason: 'Media upload error' },
  131056: { retryable: true, retryAfterSec: 60, reason: 'Too many messages to this customer' },
  130429: { retryable: true, retryAfterSec: null, reason: 'Throughput limit reached' },
  131000: {
    retryable: true,
    retryAfterSec: null,
    reason: 'WhatsApp service temporarily unavailable',
  },
  131016: {
    retryable: true,
    retryAfterSec: null,
    reason: 'WhatsApp service temporarily unavailable',
  },
  1: { retryable: true, retryAfterSec: null, reason: 'WhatsApp service temporarily unavailable' },
  2: { retryable: true, retryAfterSec: null, reason: 'WhatsApp service temporarily unavailable' },
  131009: { retryable: false, retryAfterSec: null, reason: 'Invalid message parameter' },
  131008: { retryable: false, retryAfterSec: null, reason: 'Invalid message parameter' },
  100: { retryable: false, retryAfterSec: null, reason: 'Invalid message parameter' },
  368: {
    retryable: false,
    retryAfterSec: null,
    channelEffect: 'restricted',
    reason: 'Account restricted by Meta',
  },
  131031: {
    retryable: false,
    retryAfterSec: null,
    channelEffect: 'restricted',
    reason: 'Account restricted by Meta',
  },
  133010: { retryable: false, retryAfterSec: null, reason: 'Number not registered' },
};

/** Meta error (from a send or a `failed` status) → retry decision, channel effect, bubble text. */
export const mapSendError = (input: {
  code: number | null;
  status?: number;
  tokenInvalid?: boolean;
  retryable?: boolean;
}): SendErrorMapping => {
  if (input.tokenInvalid || input.code === META_ERROR_CODES.tokenInvalid) {
    return {
      retryable: false,
      retryAfterSec: null,
      channelEffect: 'needs_reconnect',
      reason: 'Connection to WhatsApp expired',
    };
  }
  const known = input.code === null ? undefined : SEND_ERRORS[input.code];
  if (known) return { channelEffect: 'none', ...known };
  // network errors / HTTP 5xx without a code: transient
  if (input.code === null && (input.retryable ?? (input.status ?? 0) >= 500)) {
    return {
      retryable: true,
      retryAfterSec: null,
      channelEffect: 'none',
      reason: 'WhatsApp service temporarily unavailable',
    };
  }
  return {
    retryable: false,
    retryAfterSec: null,
    channelEffect: 'none',
    reason: input.code === null ? 'Message failed' : `Message failed (code ${String(input.code)})`,
  };
};

/** What a failed template send means for the template / contact (PHASE_11_PROMPT §1). */
export type TemplateSendEffect =
  'none' | 'template_sync' | 'template_paused' | 'template_disabled' | 'marketing_stopped';

const TEMPLATE_SEND_EFFECTS: Partial<Record<number, TemplateSendEffect>> = {
  132001: 'template_sync',
  132015: 'template_paused',
  132016: 'template_disabled',
  131050: 'marketing_stopped',
};

export const templateSendEffect = (code: number | null): TemplateSendEffect =>
  (code === null ? undefined : TEMPLATE_SEND_EFFECTS[code]) ?? 'none';

/** Template management errors (create / edit / delete) → our error code. */
export interface TemplateManagementError {
  code:
    | 'TEMPLATE_NAME_TAKEN'
    | 'TEMPLATE_LIMIT_REACHED'
    | 'VALIDATION_FAILED'
    | 'RATE_LIMITED'
    | 'META_API_ERROR';
  /** Our text; Meta's own title only for invalid content (scrubbed, never template text). */
  message: string;
}

/** Name exists / is being deleted (Meta subcodes; also accepted as top-level codes). */
const NAME_TAKEN = new Set([2388023, 2388024]);
const LIMIT = new Set([2388042]);
const INVALID = new Set([2388040, 2388047]);
/** Template creation rate (80008) and the WABA rate limit (80007, Meta's reference). */
const RATE = new Set([80007, 80008]);

const matches = (set: ReadonlySet<number>, err: Pick<MetaApiError, 'code' | 'subcode'>) =>
  (err.code !== null && set.has(err.code)) || (err.subcode !== null && set.has(err.subcode));

export const mapTemplateError = (
  err: Pick<MetaApiError, 'code' | 'subcode' | 'message'>,
): TemplateManagementError => {
  if (matches(NAME_TAKEN, err)) {
    return {
      code: 'TEMPLATE_NAME_TAKEN',
      message: 'WhatsApp already has a template with this name and language (or is deleting it)',
    };
  }
  if (matches(LIMIT, err)) {
    return { code: 'TEMPLATE_LIMIT_REACHED', message: 'The WhatsApp template limit is reached' };
  }
  if (matches(INVALID, err)) {
    return { code: 'VALIDATION_FAILED', message: scrubSecrets(err.message).slice(0, 300) };
  }
  if (matches(RATE, err)) {
    return { code: 'RATE_LIMITED', message: 'Too many template changes — try again later' };
  }
  const n = err.subcode ?? err.code;
  return {
    code: 'META_API_ERROR',
    message:
      n === null ? 'Meta refused the template' : `Meta refused the template (code ${String(n)})`,
  };
};

/* ── Phase 12: calling ─────────────────────────────────────────────────────── */

export type CallErrorCode =
  | 'WHATSAPP_CALLING_DISABLED'
  | 'WHATSAPP_CALLING_UNAVAILABLE'
  | 'WHATSAPP_CALLING_RESTRICTED'
  | 'WHATSAPP_CALL_PERMISSION_MISSING'
  | 'WHATSAPP_CALL_PERMISSION_CHECK_FAILED'
  | 'WHATSAPP_CALL_PERMISSION_LIMIT'
  | 'WHATSAPP_CALL_PERMISSION_EXISTS'
  | 'WHATSAPP_CALL_LIMIT_REACHED'
  | 'WHATSAPP_CALL_ACTIVE'
  | 'WHATSAPP_CALL_FAILED'
  | 'RATE_LIMITED'
  | 'META_API_ERROR';

/** A failed calling Graph call → our error (PHASE_12_PROMPT §1). Reasons are ours, never Meta's text. */
export interface CallErrorMapping {
  code: CallErrorCode;
  reason: string | null;
  /** Meta's wait hint (138002 / 138005) or the next allowed time (138012), when given. */
  retryAfterSec: number | null;
  /** 613: retry once after 1 s, then `WHATSAPP_CALL_PERMISSION_CHECK_FAILED`. */
  retryOnce: boolean;
}

const CALL_FAILED_REASONS: Record<number, string> = {
  138001: "The customer can't take WhatsApp calls",
  138004: 'WhatsApp could not connect the call',
  138007: 'The call could not be set up (media)',
  138019: 'The call was not connected',
  138020: 'The call was not connected',
  138021: 'The call was not connected',
  138022: 'The call was not connected',
  138023: 'The call was not connected',
  131030: 'Test number not on the allowed list',
  131044: 'Payment method missing at Meta',
};

const CALL_ERROR_CODES: Partial<Record<number, CallErrorCode>> = {
  138000: 'WHATSAPP_CALLING_DISABLED',
  138002: 'RATE_LIMITED',
  138005: 'RATE_LIMITED',
  138003: 'WHATSAPP_CALL_ACTIVE',
  138006: 'WHATSAPP_CALL_PERMISSION_MISSING',
  138009: 'WHATSAPP_CALL_PERMISSION_LIMIT',
  138012: 'WHATSAPP_CALL_LIMIT_REACHED',
  138013: 'WHATSAPP_CALLING_UNAVAILABLE',
  138015: 'WHATSAPP_CALLING_UNAVAILABLE',
  138018: 'WHATSAPP_CALLING_UNAVAILABLE',
  138014: 'WHATSAPP_CALLING_RESTRICTED',
  138017: 'WHATSAPP_CALL_PERMISSION_EXISTS',
  131055: 'WHATSAPP_CALLING_UNAVAILABLE',
};

/** Whole seconds from Meta's `error_data` hint (seconds or a unix time), if any. */
export const callRetryAfterSec = (
  hint: number | string | null | undefined,
  now = Date.now(),
): number | null => {
  const n = Number(hint);
  if (hint === null || hint === undefined || hint === '' || !Number.isFinite(n) || n <= 0)
    return null;
  // a unix time (after 2001) → seconds from now; else already seconds
  return n > 1_000_000_000 ? Math.max(0, Math.ceil(n - now / 1000)) : Math.ceil(n);
};

export const mapCallError = (
  err: Pick<MetaApiError, 'code' | 'subcode' | 'status' | 'retryable' | 'tokenInvalid'>,
  hint?: number | string | null,
): CallErrorMapping => {
  const n = err.code;
  const base = { reason: null, retryAfterSec: null, retryOnce: false };
  if (n === 613) return { ...base, code: 'WHATSAPP_CALL_PERMISSION_CHECK_FAILED', retryOnce: true };
  if (n !== null && n in CALL_FAILED_REASONS) {
    return { ...base, code: 'WHATSAPP_CALL_FAILED', reason: CALL_FAILED_REASONS[n] ?? null };
  }
  const code = n === null ? undefined : CALL_ERROR_CODES[n];
  if (code) {
    const timed = code === 'RATE_LIMITED' || code === 'WHATSAPP_CALL_LIMIT_REACHED';
    return {
      ...base,
      code,
      reason: n === 131055 ? 'SIP is enabled on this number' : null,
      retryAfterSec: timed ? callRetryAfterSec(hint) : null,
    };
  }
  return { ...base, code: 'META_API_ERROR' };
};

/** 131026 on a call permission request / call button → the bubble reason. */
export const CALL_MESSAGE_OLD_CLIENT_REASON = "Customer's WhatsApp is too old";
