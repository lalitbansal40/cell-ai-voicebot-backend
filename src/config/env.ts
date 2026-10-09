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

const RawEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema.default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5100),
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
  if (production) {
    check('AI_PROVIDER', 'must be openai in production', aiProvider === 'openai');
    check('AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS', 'must be false in production', !allowPrivateHosts);
    check('MOCK_APIS_ENABLED', 'must be false in production', !mockApis);
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
