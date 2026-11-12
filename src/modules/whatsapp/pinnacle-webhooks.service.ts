import { timingSafeEqual } from 'node:crypto';

import { Types } from 'mongoose';

import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import { openSecret, type WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { ingestEnvelope, parseEnvelope, type WebhookReceipt } from './webhooks.service';

/** PN (D8): the header Pinnacle sends back on every relayed callback (set by `setwebhook`). */
export const PINNACLE_SECRET_HEADER = 'x-cell-webhook-secret';

/** Our callback URL for a managed number (given to Pinnacle's `setwebhook`). */
export const pinnacleWebhookUrl = (
  env: Pick<WhatsAppContext['env'], 'APP_URL'>,
  channelId: Types.ObjectId | string,
): string => `${env.APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/pinnacle/${channelId.toString()}`;

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * `POST /api/v1/webhooks/pinnacle/:channelId` — Meta's payload relayed by Pinnacle for one
 * managed number. Authenticated by the per-number secret header; only that number's
 * changes are stored (same store / queue / fast path as Meta's own webhooks).
 */
export const receivePinnacleWebhook = async (
  ctx: WhatsAppContext,
  jobs: WhatsAppJobs,
  channelId: string,
  rawBody: Buffer,
  secret: string | undefined,
): Promise<WebhookReceipt> => {
  if (!Types.ObjectId.isValid(channelId)) throw new NotFoundError('Not found');
  const channel = await WhatsAppChannelModel.findById(channelId)
    .select('+pinnacle.webhookSecretSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel || channel.provider !== 'pinnacle' || channel.status === 'disconnected') {
    throw new NotFoundError('Not found');
  }
  const sealed = channel.pinnacle?.webhookSecretSealed;
  let expected: string | null = null;
  try {
    expected = sealed ? openSecret(ctx, sealed) : null;
  } catch {
    expected = null;
  }
  if (!expected || !secret || !sameSecret(secret, expected)) {
    getLogger().warn(
      { metric: 'pinnacle_webhook_forbidden', channelId },
      'pinnacle webhook: missing or wrong secret',
    );
    throw new AppError('PINNACLE_WEBHOOK_FORBIDDEN');
  }
  return ingestEnvelope(ctx, jobs, parseEnvelope(rawBody), { source: 'pinnacle', channel });
};
