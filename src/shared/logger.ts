import pino, { stdTimeFunctions, type DestinationStream, type Logger } from 'pino';

import { getEnv, type Env } from '../config/env';

import { getAppInfo } from './app-info';

/** Paths censored in every log line (ADR 0007, docs/conventions/code-style.md §4). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'req.body',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.otp',
  '*.resetToken',
  '*.inviteToken',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.authorization',
];

export type { Logger };

/**
 * Builds a pino logger. `destination` lets tests capture output.
 * Pretty output only for development on an interactive terminal.
 */
export const createLogger = (
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>,
  destination?: DestinationStream,
): Logger => {
  const pretty = !destination && env.NODE_ENV === 'development' && process.stdout.isTTY;
  return pino(
    {
      level: env.LOG_LEVEL,
      base: {
        service: 'cell-ai-voicebot-backend',
        env: env.NODE_ENV,
        version: getAppInfo().version,
      },
      timestamp: stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      ...(pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
    destination,
  );
};

let cached: Logger | undefined;

/** Process-wide logger, created lazily from the validated env. */
export const getLogger = (): Logger => {
  cached ??= createLogger(getEnv());
  return cached;
};
