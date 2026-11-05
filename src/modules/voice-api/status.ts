import type { Redis } from 'ioredis';

import { getEnv } from '../../config/env';
import { getAppRedis } from '../../core/queues/redis';
import { VoiceApiError } from '../../core/voice-api/types';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { notifyPlatform } from '../notifications/notifications.service';

/**
 * Health of the Cell24x7 connection for Admin → System (VAPI): last webhook seen and the
 * last provider error. Redis hash `vapi:status`; superadmin bell at most once an hour per code.
 */

const KEY = 'vapi:status';

const redisOf = (): Redis => {
  const env = getEnv();
  return getAppRedis(env.REDIS_URL, getLogger());
};

/** The public result webhook (the secret is a path segment; never logged or audited). */
export const voiceWebhookUrl = (): string => {
  const env = getEnv();
  return `${env.APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/voice-api/${env.CELL24X7_WEBHOOK_SECRET}`;
};

export const recordWebhookSeen = async (): Promise<void> => {
  await redisOf()
    .hset(KEY, 'lastWebhookAt', new Date().toISOString())
    .catch(() => undefined);
};

const ERROR_TEXT: Record<string, string> = {
  VOICE_API_AUTH: 'Cell24x7 refused our API token. Generate a new token and update the server.',
  VOICE_API_NO_CREDITS: 'Cell24x7 credits are too low. Recorded-voice campaigns are paused.',
  VOICE_API_REJECTED: 'Cell24x7 refused a batch. Check the campaign and the audio.',
  VOICE_API_UNAVAILABLE:
    'Cell24x7 did not answer a submit. Check its dashboard, then resolve the batch in Admin → System.',
};

/** Remembers the error and rings the superadmins once an hour per error code. */
export const recordProviderError = async (code: string): Promise<void> => {
  const redis = redisOf();
  await redis
    .hset(KEY, 'lastErrorCode', code, 'lastErrorAt', new Date().toISOString())
    .catch(() => undefined);
  const first = await redis.set(`vapi:alert:${code}`, '1', 'EX', 3600, 'NX').catch(() => null);
  if (first !== 'OK') return;
  await notifyPlatform({
    type: 'voice_api.provider_error',
    title: 'Recorded-voice provider problem',
    body: ERROR_TEXT[code] ?? 'Cell24x7 returned an error. Check Admin → System.',
    link: '/admin/system',
  }).catch(() => 0);
};

export const readProviderStatus = async (): Promise<{
  lastWebhookAt: string | null;
  lastError: { code: string; at: string } | null;
}> => {
  let values: Record<string, string> = {};
  try {
    values = await redisOf().hgetall(KEY);
  } catch {
    // status is best effort
  }
  return {
    lastWebhookAt: values.lastWebhookAt ?? null,
    lastError:
      values.lastErrorCode && values.lastErrorAt
        ? { code: values.lastErrorCode, at: values.lastErrorAt }
        : null,
  };
};

/** A provider error as an API error (`notFound` = the code to use for a 404). */
export const toAppError = (
  err: unknown,
  notFound: 'VOICE_API_IVR_MISSING' | 'VOICE_API_AUDIO_INVALID' = 'VOICE_API_IVR_MISSING',
): AppError => {
  if (err instanceof AppError) return err;
  if (!(err instanceof VoiceApiError)) return new AppError('VOICE_API_UNAVAILABLE');
  switch (err.code) {
    case 'VOICE_API_AUTH':
      return new AppError('VOICE_API_AUTH');
    case 'VOICE_API_NO_CREDITS':
      return new AppError('VOICE_API_NO_CREDITS');
    case 'VOICE_API_REJECTED':
      return new AppError('VOICE_API_REJECTED');
    case 'VOICE_API_NOT_FOUND':
      return new AppError(notFound);
    default:
      return new AppError('VOICE_API_UNAVAILABLE');
  }
};
