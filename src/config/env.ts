import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { isGstStateCode } from '../shared/gst-states';
import { isValidGstin } from '../shared/gstin';

/**
 * Environment configuration (ADR 0006, docs/conventions/secrets.md).
 * The ONLY place that reads `process.env`. Invalid or missing variables stop
 * the app at startup with a message listing variable NAMES — never values.
 */

const NodeEnvSchema = z.enum(['development', 'test', 'production']);
const LogLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const DURATION = /^\d+[smhd]$/;
const PLACEHOLDER = /^change-me/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const LOCAL_MONGODB_URI = 'mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0';
const LOCAL_REDIS_URL = 'redis://127.0.0.1:6380';
const DEV_MAIL_FROM = 'Cell AI Voicebot <no-reply@localhost>';

const optionalString = z.string().optional();

/** Meta Graph API host (tests may point `META_GRAPH_BASE_URL` at a local stub; production may not). */
export const META_GRAPH_DEFAULT_URL = 'https://graph.facebook.com';
const DEV_META_VERIFY_TOKEN = 'dev-meta-verify-token';
const DEV_FAKE_META_APP_SECRET = 'dev-fake-meta-app-secret';

const RawEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema.default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5100),
  /**
   * Address the API listens on (Phase 13): `0.0.0.0` (all interfaces, default) or e.g.
   * `127.0.0.1` behind nginx when the container uses host networking.
   */
  HOST: z.union([z.ipv4(), z.ipv6(), z.literal('localhost')]).default('0.0.0.0'),
  /** Build info shown by `GET /health` (Phase 13; set by the image build, never secret). */
  GIT_SHA: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, { message: 'must be a git commit sha' })
    .optional(),
  BUILT_AT: z.iso.datetime({ offset: true }).optional(),
  /** Public auth routes: requests per 15 minutes per IP and route (default 30; refresh has its own). */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(5).max(10_000).default(30),
  APP_URL: z.url().optional(),
  FRONTEND_URL: z.url().optional(),
  CORS_ORIGINS: optionalString,
  LOG_LEVEL: LogLevelSchema.optional(),
  TRUST_PROXY: optionalString,
  API_DOCS_ENABLED: z.enum(['true', 'false'], { message: 'must be true or false' }).optional(),

  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://')
    .optional(),
  WORKERS_ENABLED: z
    .enum(['true', 'false'], { message: 'must be true or false' })
    .default('true')
    .transform((v) => v === 'true'),

  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, 'must start with redis:// or rediss://')
    .optional(),

  JWT_ACCESS_SECRET: optionalString,
  JWT_REFRESH_SECRET: optionalString,
  JWT_ACCESS_TTL: z.string().regex(DURATION, 'must look like 15m, 30d, 3600s').default('15m'),
  JWT_REFRESH_TTL: z.string().regex(DURATION, 'must look like 15m, 30d, 3600s').default('30d'),
  ENCRYPTION_KEY: optionalString,
  /** Cookie domain for the refresh cookie (e.g. `.example.com`); empty = host-only. */
  AUTH_COOKIE_DOMAIN: optionalString,
  /** DEV ONLY — password for `npm run db:seed` users (random when empty). */
  SEED_PASSWORD: optionalString,

  OPENAI_API_KEY: optionalString,
  OPENAI_REALTIME_MODEL: optionalString,
  /** `fake` (deterministic, dev / tests / E2E) or `openai`; default openai when a key is set. */
  AI_PROVIDER: z.enum(['fake', 'openai']).optional(),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  OPENAI_TEXT_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, { message: 'must be a model id like gpt-4.1-mini' })
    .default('gpt-4.1-mini'),
  OPENAI_EMBEDDING_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, { message: 'must be a model id' })
    .default('text-embedding-3-small'),
  /** Comma list of text models agents may choose (must include OPENAI_TEXT_MODEL). */
  AI_TEXT_MODELS: optionalString,
  AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: z
    .enum(['true', 'false'], { message: 'must be true or false' })
    .optional(),
  MOCK_APIS_ENABLED: z.enum(['true', 'false'], { message: 'must be true or false' }).optional(),

  /** Voice AI for calls (Phase 7): `fake` (deterministic) or `openai`; default = resolved AI_PROVIDER. */
  VOICE_PROVIDER: z.enum(['fake', 'openai']).optional(),
  /** `realtime` (OpenAI speech-to-speech) or `chat` (STT → chat model → TTS). */
  VOICE_PIPELINE: z.enum(['realtime', 'chat']).default('realtime'),
  /** DEV / TEST ONLY — typed customer text on web calls (`call.say_text`); never in production. */
  VOICE_TEXT_INPUT_ENABLED: z
    .enum(['true', 'false'], { message: 'must be true or false' })
    .optional(),
  OPENAI_TTS_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, { message: 'must be a model id' })
    .default('gpt-4o-mini-tts'),
  OPENAI_TRANSCRIBE_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, { message: 'must be a model id' })
    .default('gpt-4o-mini-transcribe'),
  /** Days calls, transcripts, events and recordings are kept (default 180). */
  CALL_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
  /** Folder for recordings being written during a call (default `<os tmp>/cav-rec`). */
  CALL_RECORDING_TMP_DIR: optionalString,

  /** Phone line for campaigns / single calls (Phase 8: `dryrun` only; `sip` arrives in Phase 13). */
  TELEPHONY_PROVIDER: z.enum(['dryrun']).default('dryrun'),
  /** Fastest dry-run speed (virtual time ×N); default 50, production 20 (≤ 20). */
  DRY_RUN_MAX_SPEED: z.coerce.number().int().min(1).max(100).optional(),
  /** `false` stops the campaign dispatchers and worker (maintenance). Default true. */
  CAMPAIGNS_ENABLED: z.enum(['true', 'false'], { message: 'must be true or false' }).optional(),

  /** WhatsApp channels (Phase 9). Default: on outside production; in production on when META_APP_ID is set. */
  WHATSAPP_ENABLED: z.enum(['true', 'false'], { message: 'must be true or false' }).optional(),
  /** `fake` (simulated Meta — dev / tests / E2E) or `meta`; production must use meta. */
  META_PROVIDER: z.enum(['fake', 'meta']).optional(),
  META_APP_ID: z.string().regex(/^\d+$/, { message: 'must be digits' }).optional(),
  META_APP_SECRET: optionalString,
  /** Facebook Login for Business configuration id used by Embedded Signup. */
  META_ES_CONFIG_ID: z.string().regex(/^\d+$/, { message: 'must be digits' }).optional(),
  META_WEBHOOK_VERIFY_TOKEN: optionalString,
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, { message: 'must look like v26.0' })
    .default('v26.0'),
  META_GRAPH_BASE_URL: z.url().default(META_GRAPH_DEFAULT_URL),
  /** Our Solution Partner credit line (platform pays Meta). Checked when a credit line is attached. */
  META_CREDIT_LINE_ID: z.string().regex(/^\d+$/, { message: 'must be digits' }).optional(),
  /** System User token of our business (business_management, Admin / Financial Editor). */
  META_SYSTEM_USER_TOKEN: optionalString,
  /** DEV / TEST ONLY — app secret of the fake Meta provider (signs simulated webhooks). */
  FAKE_META_APP_SECRET: optionalString,
  /** Days WhatsApp messages and their media are kept (Phase 10; `0` = keep forever, else ≥ 30). */
  INBOX_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  /**
   * DEV / E2E ONLY — fake Meta sends sent / delivered / read status webhooks after these
   * delays (`sent,delivered,read` ms, or `off`). Default `500,1500,3000` in development, off in tests.
   */
  FAKE_META_STATUS_DELAYS_MS: optionalString,
  /**
   * DEV / E2E ONLY — fake Meta reviews a submitted template after this delay (ms, or `off`).
   * Default `3000` in development, off in tests (Phase 11).
   */
  FAKE_META_TEMPLATE_REVIEW_MS: optionalString,
  /** WhatsApp call media in this process (Phase 12). Default: on when WhatsApp is on. */
  WA_MEDIA_ENABLED: z.enum(['true', 'false'], { message: 'must be true or false' }).optional(),
  /** Public IPv4 of this server (1:1 NAT) added as a host candidate; required with META_PROVIDER=meta. */
  WA_MEDIA_PUBLIC_IP: z.ipv4({ message: 'must be an IPv4 address' }).optional(),
  WA_MEDIA_PORT_MIN: z.coerce.number().int().min(1024).max(65535).default(40_000),
  WA_MEDIA_PORT_MAX: z.coerce.number().int().min(1024).max(65535).default(40_999),
  /** Comma list of `stun:host:port` (or `off`). Default Google's STUN; none in tests. */
  WA_STUN_URLS: optionalString,
  /** WhatsApp calls with media per process. */
  WA_MEDIA_MAX_CALLS: z.coerce.number().int().min(1).max(1000).default(50),
  /**
   * DEV / E2E ONLY — fake Meta call timings (`connect,ringing,accepted` ms, or `off` =
   * immediate). Default `100,200,800` in development, off in tests (Phase 12).
   */
  FAKE_META_CALL_DELAYS_MS: optionalString,
  /**
   * DEV / E2E ONLY — WhatsApp calls with the fake Meta skip the calling window (TRAI
   * 09:00–21:00 + the account window) so night-time test runs can call the fake phone.
   * Works only with META_PROVIDER=fake; refused in production (Phase 12).
   */
  WA_CALL_WINDOW_IGNORED: z
    .enum(['true', 'false'], { message: 'must be true or false' })
    .optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./uploads'),
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,

  EMAIL_DRIVER: z.enum(['smtp', 'log']).optional(),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['true', 'false'], { message: 'must be true or false' }).optional(),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: optionalString,

  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,

  PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).optional(),
  FAKE_PAYMENT_SECRET: optionalString,
  BILLING_SELLER_NAME: optionalString,
  BILLING_SELLER_ADDRESS: optionalString,
  BILLING_SELLER_GSTIN: optionalString,
  BILLING_SELLER_STATE_CODE: optionalString,
  BILLING_SAC_CODE: z
    .string()
    .regex(/^\d{4,8}$/, { message: 'must be 4–8 digits' })
    .default('998319'),
  BILLING_INVOICE_PREFIX: z
    .string()
    .regex(/^[A-Z]{1,3}$/, { message: 'must be 1–3 capital letters' })
    .default('CAV'),
  BILLING_SIMULATOR_ENABLED: z
    .enum(['true', 'false'], { message: 'must be true or false' })
    .optional(),

  NOTIFYNOW_API_KEY: optionalString,
  SIP_HOST: optionalString,
  SIP_PORT: z.coerce.number().int().min(1).max(65535).default(5060),
  SIP_TRANSPORT: z.enum(['udp', 'tcp', 'tls']).default('udp'),
  SIP_USERNAME: optionalString,
  SIP_PASSWORD: optionalString,
  SIP_CALLER_ID: optionalString,

  CLIENT_SSH_KEY_PATH: optionalString,
});

type RawEnv = z.infer<typeof RawEnvSchema>;

/** Every supported variable name (docs sync test: .env.example + README table). */
export const ENV_KEYS = Object.keys(RawEnvSchema.shape) as readonly (keyof RawEnv)[];

export type NodeEnv = z.infer<typeof NodeEnvSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type TrustProxy = boolean | number | string;

export type Env = Readonly<
  Omit<
    RawEnv,
    | 'CORS_ORIGINS'
    | 'LOG_LEVEL'
    | 'TRUST_PROXY'
    | 'APP_URL'
    | 'FRONTEND_URL'
    | 'MONGODB_URI'
    | 'REDIS_URL'
    | 'EMAIL_DRIVER'
    | 'SMTP_SECURE'
    | 'MAIL_FROM'
    | 'API_DOCS_ENABLED'
    | 'PAYMENT_PROVIDER'
    | 'FAKE_PAYMENT_SECRET'
    | 'BILLING_SELLER_NAME'
    | 'BILLING_SELLER_ADDRESS'
    | 'BILLING_SELLER_STATE_CODE'
    | 'BILLING_SIMULATOR_ENABLED'
    | 'AI_PROVIDER'
    | 'AI_TEXT_MODELS'
    | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS'
    | 'MOCK_APIS_ENABLED'
    | 'OPENAI_REALTIME_MODEL'
    | 'VOICE_PROVIDER'
    | 'VOICE_TEXT_INPUT_ENABLED'
    | 'CALL_RECORDING_TMP_DIR'
    | 'DRY_RUN_MAX_SPEED'
    | 'CAMPAIGNS_ENABLED'
    | 'WHATSAPP_ENABLED'
    | 'META_PROVIDER'
    | 'META_WEBHOOK_VERIFY_TOKEN'
    | 'FAKE_META_APP_SECRET'
    | 'FAKE_META_STATUS_DELAYS_MS'
    | 'FAKE_META_TEMPLATE_REVIEW_MS'
    | 'WA_MEDIA_ENABLED'
    | 'WA_STUN_URLS'
    | 'FAKE_META_CALL_DELAYS_MS'
    | 'WA_CALL_WINDOW_IGNORED'
  > & {
    APP_URL: string;
    FRONTEND_URL: string;
    CORS_ORIGINS: readonly string[];
    LOG_LEVEL: LogLevel;
    TRUST_PROXY: TrustProxy;
    MONGODB_URI: string;
    REDIS_URL: string;
    EMAIL_DRIVER: 'smtp' | 'log';
    SMTP_SECURE: boolean;
    MAIL_FROM: string;
    API_DOCS_ENABLED: boolean;
    PAYMENT_PROVIDER: 'fake' | 'razorpay';
    /** Only for the fake provider (never set in production). */
    FAKE_PAYMENT_SECRET: string | undefined;
    BILLING_SELLER_NAME: string;
    BILLING_SELLER_ADDRESS: string;
    BILLING_SELLER_STATE_CODE: string;
    BILLING_SIMULATOR_ENABLED: boolean;
    AI_PROVIDER: 'fake' | 'openai';
    AI_TEXT_MODELS: readonly string[];
    AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: boolean;
    MOCK_APIS_ENABLED: boolean;
    OPENAI_REALTIME_MODEL: string;
    VOICE_PROVIDER: 'fake' | 'openai';
    VOICE_TEXT_INPUT_ENABLED: boolean;
    CALL_RECORDING_TMP_DIR: string;
    DRY_RUN_MAX_SPEED: number;
    CAMPAIGNS_ENABLED: boolean;
    WHATSAPP_ENABLED: boolean;
    META_PROVIDER: 'fake' | 'meta';
    /** Resolved (dev default with the fake provider). */
    META_WEBHOOK_VERIFY_TOKEN: string;
    /** Only with the fake provider (never in production). */
    FAKE_META_APP_SECRET: string | undefined;
    /** Fake Meta auto-status delays `[sent, delivered, read]`; null = off. */
    FAKE_META_STATUS_DELAYS_MS: readonly [number, number, number] | null;
    /** Fake Meta template review delay; null = off (templates stay in review). */
    FAKE_META_TEMPLATE_REVIEW_MS: number | null;
    WA_MEDIA_ENABLED: boolean;
    WA_STUN_URLS: readonly string[];
    /** Fake Meta call timings `[connect, ringing, accepted]`; null = immediate. */
    FAKE_META_CALL_DELAYS_MS: readonly [number, number, number] | null;
    /** True only with the fake Meta outside production (E2E at night). */
    WA_CALL_WINDOW_IGNORED: boolean;
  }
>;

export interface EnvIssue {
  variable: string;
  reason: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: EnvIssue[]) {
    super(`Invalid environment: ${issues.map((i) => `${i.variable} (${i.reason})`).join(', ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/** Empty strings in .env files mean "not set". */
const dropEmpty = (source: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value.trim();
  }
  return out;
};

const parseTrustProxy = (value: string | undefined): TrustProxy => {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback", "10.0.0.0/8"
};

const parseOrigins = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

/** `off` → null; `a,b,c` (ms, 0–60000) → tuple; anything else → undefined (invalid). */
const parseStatusDelays = (value: string): readonly [number, number, number] | null | undefined => {
  if (value.toLowerCase() === 'off') return null;
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,5}$/.test(p))) return undefined;
  const [sent, delivered, read] = parts.map(Number) as [number, number, number];
  if ([sent, delivered, read].some((n) => n > 60_000)) return undefined;
  return Object.freeze([sent, delivered, read] as const);
};

const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';
const STUN_URL = /^stun:[A-Za-z0-9.-]+:\d{1,5}$/;

/** `off` → []; `stun:host:port[,…]` → list; anything else → undefined (invalid). */
const parseStunUrls = (value: string): string[] | undefined => {
  if (value.trim().toLowerCase() === 'off') return [];
  const urls = value.split(',').map((u) => u.trim());
  return urls.every((u) => STUN_URL.test(u)) ? urls : undefined;
};

/** `off` → null; ms 0–600000 → number; anything else → undefined (invalid). */
const parseReviewDelay = (value: string): number | null | undefined => {
  if (value.trim().toLowerCase() === 'off') return null;
  if (!/^\d{1,6}$/.test(value.trim())) return undefined;
  const ms = Number(value.trim());
  return ms <= 600_000 ? ms : undefined;
};

const isValidUrl = (value: string): boolean => z.url().safeParse(value).success;

/** Parses and validates an environment. Pure — pass any object in tests. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const parsed = RawEnvSchema.safeParse(dropEmpty(source));
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => ({
        variable: String(issue.path[0] ?? 'unknown'),
        reason: issue.message,
      })),
    );
  }

  const raw = parsed.data;
  const production = raw.NODE_ENV === 'production';
  const issues: EnvIssue[] = [];
  const check = (variable: keyof RawEnv, reason: string, ok: boolean) => {
    if (!ok) issues.push({ variable, reason });
  };

  const frontendUrl = raw.FRONTEND_URL ?? (production ? '' : 'http://localhost:3100');
  const appUrl = raw.APP_URL ?? (production ? '' : `http://localhost:${raw.PORT}`);
  const origins =
    raw.CORS_ORIGINS !== undefined
      ? parseOrigins(raw.CORS_ORIGINS)
      : frontendUrl
        ? [frontendUrl]
        : [];
  const badOrigin = origins.find((o) => !isValidUrl(o));
  if (badOrigin !== undefined)
    issues.push({ variable: 'CORS_ORIGINS', reason: 'every entry must be a URL' });

  if (production) {
    check('APP_URL', 'required in production', Boolean(raw.APP_URL));
    check('FRONTEND_URL', 'required in production', Boolean(raw.FRONTEND_URL));
    check('CORS_ORIGINS', 'required in production', origins.length > 0);
    check('MONGODB_URI', 'required in production', Boolean(raw.MONGODB_URI));
    check('REDIS_URL', 'required in production', Boolean(raw.REDIS_URL));
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      const value = raw[key];
      check(
        key,
        'required in production, min 32 chars, not a placeholder',
        value !== undefined && value.length >= 32 && !PLACEHOLDER.test(value),
      );
    }
    const key = raw.ENCRYPTION_KEY;
    check(
      'ENCRYPTION_KEY',
      'required in production, base64 of exactly 32 bytes',
      key !== undefined && BASE64.test(key) && Buffer.from(key, 'base64').length === 32,
    );
  }

  if (raw.STORAGE_DRIVER === 's3') {
    for (const key of [
      'S3_BUCKET',
      'S3_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ] as const) {
      check(key, 'required when STORAGE_DRIVER=s3', Boolean(raw[key]));
    }
  }

  const emailDriver = raw.EMAIL_DRIVER ?? (raw.SMTP_HOST ? 'smtp' : 'log');
  if (emailDriver === 'smtp') {
    check('SMTP_HOST', 'required when EMAIL_DRIVER=smtp', Boolean(raw.SMTP_HOST));
    if (production) check('MAIL_FROM', 'required in production', Boolean(raw.MAIL_FROM));
  }
  check(
    'SMTP_USER',
    'SMTP_USER and SMTP_PASS must be set together',
    Boolean(raw.SMTP_USER) === Boolean(raw.SMTP_PASS),
  );
  if (production) {
    check(
      'EMAIL_DRIVER',
      'EMAIL_DRIVER=log is not allowed in production (set SMTP_HOST)',
      emailDriver === 'smtp',
    );
  }

  const paymentProvider = raw.PAYMENT_PROVIDER ?? (production ? 'razorpay' : 'fake');
  if (paymentProvider === 'razorpay') {
    for (const key of [
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ] as const) {
      check(key, 'required when PAYMENT_PROVIDER=razorpay', Boolean(raw[key]));
    }
  }
  const sellerState = raw.BILLING_SELLER_STATE_CODE ?? (production ? '' : '08');
  if (raw.BILLING_SELLER_STATE_CODE !== undefined || production) {
    check(
      'BILLING_SELLER_STATE_CODE',
      'must be a GST state code (e.g. 08)',
      isGstStateCode(sellerState),
    );
  }
  if (raw.BILLING_SELLER_GSTIN !== undefined) {
    check(
      'BILLING_SELLER_GSTIN',
      'must be a valid GSTIN of BILLING_SELLER_STATE_CODE',
      isValidGstin(raw.BILLING_SELLER_GSTIN, sellerState),
    );
  }
  if (production) {
    check('PAYMENT_PROVIDER', 'must be razorpay in production', paymentProvider === 'razorpay');
    check(
      'FAKE_PAYMENT_SECRET',
      'must not be set in production',
      raw.FAKE_PAYMENT_SECRET === undefined,
    );
    for (const key of [
      'BILLING_SELLER_NAME',
      'BILLING_SELLER_ADDRESS',
      'BILLING_SELLER_GSTIN',
    ] as const) {
      check(key, 'required in production', Boolean(raw[key]));
    }
  }

  const aiProvider = raw.AI_PROVIDER ?? (raw.OPENAI_API_KEY || production ? 'openai' : 'fake');
  const textModels = (raw.AI_TEXT_MODELS ?? raw.OPENAI_TEXT_MODEL)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  check(
    'AI_TEXT_MODELS',
    'must list model ids and include OPENAI_TEXT_MODEL',
    textModels.includes(raw.OPENAI_TEXT_MODEL) &&
      textModels.every((m) => /^[a-z0-9][a-z0-9.-]{1,63}$/.test(m)),
  );
  if (aiProvider === 'openai') {
    check('OPENAI_API_KEY', 'required when AI_PROVIDER=openai', Boolean(raw.OPENAI_API_KEY));
  }
  const allowPrivateHosts =
    raw.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS !== undefined
      ? raw.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS === 'true'
      : !production;
  const mockApis =
    raw.MOCK_APIS_ENABLED !== undefined ? raw.MOCK_APIS_ENABLED === 'true' : !production;
  const voiceProvider = raw.VOICE_PROVIDER ?? aiProvider;
  if (voiceProvider === 'openai' && aiProvider !== 'openai') {
    check('OPENAI_API_KEY', 'required when VOICE_PROVIDER=openai', Boolean(raw.OPENAI_API_KEY));
  }
  if (raw.OPENAI_REALTIME_MODEL !== undefined) {
    check(
      'OPENAI_REALTIME_MODEL',
      'must be a model id like gpt-realtime-2.1-mini',
      /^[a-z0-9][a-z0-9.-]{1,63}$/.test(raw.OPENAI_REALTIME_MODEL),
    );
  }
  const voiceTextInput =
    raw.VOICE_TEXT_INPUT_ENABLED !== undefined
      ? raw.VOICE_TEXT_INPUT_ENABLED === 'true'
      : !production;
  const dryRunMaxSpeed = raw.DRY_RUN_MAX_SPEED ?? (production ? 20 : 50);
  if (production) {
    check('DRY_RUN_MAX_SPEED', 'must be at most 20 in production', dryRunMaxSpeed <= 20);
  }
  if (production) {
    check('VOICE_PROVIDER', 'must be openai in production', voiceProvider === 'openai');
    check('VOICE_TEXT_INPUT_ENABLED', 'must be false in production', !voiceTextInput);
  }
  if (production) {
    check('AI_PROVIDER', 'must be openai in production', aiProvider === 'openai');
    check('AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS', 'must be false in production', !allowPrivateHosts);
    check('MOCK_APIS_ENABLED', 'must be false in production', !mockApis);
    check(
      'WA_CALL_WINDOW_IGNORED',
      'must not be set in production',
      raw.WA_CALL_WINDOW_IGNORED !== 'true',
    );
  }

  const whatsappEnabled =
    raw.WHATSAPP_ENABLED !== undefined
      ? raw.WHATSAPP_ENABLED === 'true'
      : production
        ? Boolean(raw.META_APP_ID)
        : true;
  const metaProvider = raw.META_PROVIDER ?? (production ? 'meta' : 'fake');
  if (whatsappEnabled && metaProvider === 'meta') {
    check('META_APP_ID', 'required when META_PROVIDER=meta', Boolean(raw.META_APP_ID));
    check(
      'META_APP_SECRET',
      'required when META_PROVIDER=meta, min 32 chars, not a placeholder',
      raw.META_APP_SECRET !== undefined &&
        raw.META_APP_SECRET.length >= 32 &&
        !PLACEHOLDER.test(raw.META_APP_SECRET),
    );
    check('META_ES_CONFIG_ID', 'required when META_PROVIDER=meta', Boolean(raw.META_ES_CONFIG_ID));
    check(
      'META_WEBHOOK_VERIFY_TOKEN',
      'required when META_PROVIDER=meta, min 24 chars, not a placeholder',
      raw.META_WEBHOOK_VERIFY_TOKEN !== undefined &&
        raw.META_WEBHOOK_VERIFY_TOKEN.length >= 24 &&
        !PLACEHOLDER.test(raw.META_WEBHOOK_VERIFY_TOKEN),
    );
  }
  if (production && whatsappEnabled) {
    check('META_PROVIDER', 'must be meta in production', metaProvider === 'meta');
    check(
      'META_GRAPH_BASE_URL',
      'must be the default in production',
      raw.META_GRAPH_BASE_URL === META_GRAPH_DEFAULT_URL,
    );
  }
  if (production) {
    check(
      'FAKE_META_APP_SECRET',
      'must not be set in production',
      raw.FAKE_META_APP_SECRET === undefined,
    );
  }

  check(
    'INBOX_RETENTION_DAYS',
    'must be 0 (keep forever) or at least 30',
    raw.INBOX_RETENTION_DAYS === 0 || raw.INBOX_RETENTION_DAYS >= 30,
  );
  if (production) {
    check(
      'FAKE_META_STATUS_DELAYS_MS',
      'must not be set in production',
      raw.FAKE_META_STATUS_DELAYS_MS === undefined,
    );
  }
  const statusDelays = parseStatusDelays(
    raw.FAKE_META_STATUS_DELAYS_MS ??
      (raw.NODE_ENV === 'development' && metaProvider === 'fake' ? '500,1500,3000' : 'off'),
  );
  if (statusDelays === undefined) {
    issues.push({
      variable: 'FAKE_META_STATUS_DELAYS_MS',
      reason: 'must be off or three delays in ms (sent,delivered,read), each 0–60000',
    });
  }

  if (production) {
    check(
      'FAKE_META_TEMPLATE_REVIEW_MS',
      'must not be set in production',
      raw.FAKE_META_TEMPLATE_REVIEW_MS === undefined,
    );
  }
  const reviewDelay = parseReviewDelay(
    raw.FAKE_META_TEMPLATE_REVIEW_MS ??
      (raw.NODE_ENV === 'development' && metaProvider === 'fake' ? '3000' : 'off'),
  );
  if (reviewDelay === undefined) {
    issues.push({
      variable: 'FAKE_META_TEMPLATE_REVIEW_MS',
      reason: 'must be off or a delay in ms (0–600000)',
    });
  }

  const waMediaEnabled =
    raw.WA_MEDIA_ENABLED !== undefined ? raw.WA_MEDIA_ENABLED === 'true' : whatsappEnabled;
  check(
    'WA_MEDIA_PORT_MAX',
    'must be at least WA_MEDIA_PORT_MIN + 99 (100 ports or more)',
    raw.WA_MEDIA_PORT_MAX >= raw.WA_MEDIA_PORT_MIN + 99,
  );
  if (whatsappEnabled && waMediaEnabled && metaProvider === 'meta') {
    check(
      'WA_MEDIA_PUBLIC_IP',
      'required when META_PROVIDER=meta',
      Boolean(raw.WA_MEDIA_PUBLIC_IP),
    );
  }
  const stunUrls = parseStunUrls(
    raw.WA_STUN_URLS ?? (raw.NODE_ENV === 'test' ? 'off' : DEFAULT_STUN_URL),
  );
  if (stunUrls === undefined) {
    issues.push({
      variable: 'WA_STUN_URLS',
      reason: 'must be off or a comma list of stun:host:port',
    });
  }
  if (production) {
    check(
      'FAKE_META_CALL_DELAYS_MS',
      'must not be set in production',
      raw.FAKE_META_CALL_DELAYS_MS === undefined,
    );
  }
  const callDelays = parseStatusDelays(
    raw.FAKE_META_CALL_DELAYS_MS ??
      (raw.NODE_ENV === 'development' && metaProvider === 'fake' ? '100,200,800' : 'off'),
  );
  if (callDelays === undefined) {
    issues.push({
      variable: 'FAKE_META_CALL_DELAYS_MS',
      reason: 'must be off or three delays in ms (connect,ringing,accepted), each 0–60000',
    });
  }

  if (issues.length) throw new EnvValidationError(issues);

  const defaultLogLevel: Record<NodeEnv, LogLevel> = {
    development: 'debug',
    test: 'silent',
    production: 'info',
  };

  return Object.freeze({
    ...raw,
    APP_URL: appUrl,
    FRONTEND_URL: frontendUrl,
    CORS_ORIGINS: Object.freeze(origins),
    LOG_LEVEL: raw.LOG_LEVEL ?? defaultLogLevel[raw.NODE_ENV],
    TRUST_PROXY: parseTrustProxy(raw.TRUST_PROXY),
    MONGODB_URI: raw.MONGODB_URI ?? LOCAL_MONGODB_URI,
    REDIS_URL: raw.REDIS_URL ?? LOCAL_REDIS_URL,
    EMAIL_DRIVER: emailDriver,
    SMTP_SECURE: raw.SMTP_SECURE !== undefined ? raw.SMTP_SECURE === 'true' : raw.SMTP_PORT === 465,
    MAIL_FROM: raw.MAIL_FROM ?? DEV_MAIL_FROM,
    API_DOCS_ENABLED:
      raw.API_DOCS_ENABLED !== undefined ? raw.API_DOCS_ENABLED === 'true' : !production,
    PAYMENT_PROVIDER: paymentProvider,
    FAKE_PAYMENT_SECRET:
      paymentProvider === 'fake'
        ? (raw.FAKE_PAYMENT_SECRET ?? 'dev-fake-payment-secret')
        : undefined,
    BILLING_SELLER_NAME: raw.BILLING_SELLER_NAME ?? 'Cell AI Voicebot (sample seller)',
    BILLING_SELLER_ADDRESS:
      raw.BILLING_SELLER_ADDRESS ?? 'Sample address, Jaipur, Rajasthan 302001',
    BILLING_SELLER_STATE_CODE: sellerState,
    BILLING_SIMULATOR_ENABLED:
      raw.BILLING_SIMULATOR_ENABLED !== undefined
        ? raw.BILLING_SIMULATOR_ENABLED === 'true'
        : !production,
    AI_PROVIDER: aiProvider,
    AI_TEXT_MODELS: Object.freeze(textModels),
    AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: allowPrivateHosts,
    MOCK_APIS_ENABLED: mockApis,
    OPENAI_REALTIME_MODEL: raw.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1-mini',
    VOICE_PROVIDER: voiceProvider,
    VOICE_TEXT_INPUT_ENABLED: voiceTextInput,
    CALL_RECORDING_TMP_DIR: raw.CALL_RECORDING_TMP_DIR ?? join(tmpdir(), 'cav-rec'),
    DRY_RUN_MAX_SPEED: dryRunMaxSpeed,
    CAMPAIGNS_ENABLED: raw.CAMPAIGNS_ENABLED !== 'false',
    WHATSAPP_ENABLED: whatsappEnabled,
    META_PROVIDER: metaProvider,
    META_WEBHOOK_VERIFY_TOKEN:
      raw.META_WEBHOOK_VERIFY_TOKEN ?? (metaProvider === 'fake' ? DEV_META_VERIFY_TOKEN : ''),
    FAKE_META_APP_SECRET:
      metaProvider === 'fake' ? (raw.FAKE_META_APP_SECRET ?? DEV_FAKE_META_APP_SECRET) : undefined,
    FAKE_META_STATUS_DELAYS_MS:
      metaProvider === 'fake' && !production ? (statusDelays ?? null) : null,
    FAKE_META_TEMPLATE_REVIEW_MS:
      metaProvider === 'fake' && !production ? (reviewDelay ?? null) : null,
    WA_MEDIA_ENABLED: whatsappEnabled && waMediaEnabled,
    WA_STUN_URLS: Object.freeze(stunUrls ?? []),
    FAKE_META_CALL_DELAYS_MS: metaProvider === 'fake' && !production ? (callDelays ?? null) : null,
    WA_CALL_WINDOW_IGNORED:
      raw.WA_CALL_WINDOW_IGNORED === 'true' && metaProvider === 'fake' && !production,
  });
};

let cached: Env | undefined;

/** Process-wide env (validated once). */
export const getEnv = (): Env => {
  cached ??= loadEnv();
  return cached;
};

/** Clears the cached env — tests only. */
export const resetEnvForTests = (): void => {
  cached = undefined;
};
