import { z } from 'zod';

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

  OPENAI_API_KEY: optionalString,
  OPENAI_REALTIME_MODEL: optionalString,

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
