import { Types } from 'mongoose';

import { isMetaApiError, mapTemplateError } from '../../core/meta';
import {
  WhatsAppChannelModel,
  type WaChannelStatus,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { markNeedsReconnect, TOKEN_INVALID_REASON } from '../whatsapp/channel-status';
import { openSecret } from '../whatsapp/context';
import { metaApiError, notReady } from '../whatsapp/errors';

import type { TemplateContext } from './context';

/** Statuses whose token can manage templates (a restricted number keeps its templates). */
const MANAGING_STATUSES: WaChannelStatus[] = ['connected', 'restricted', 'action_needed'];
const MANAGING = new Set<string>(MANAGING_STATUSES);

/** A channel of the account (404 for another account's id). */
export const loadAccountChannel = async (
  accountId: Types.ObjectId,
  channelId: string,
): Promise<WhatsAppChannelDoc> => {
  if (!Types.ObjectId.isValid(channelId)) throw new NotFoundError('WhatsApp number not found');
  const channel = await WhatsAppChannelModel.findOne({
    _id: channelId,
    accountId,
    status: { $ne: 'disconnected' },
  }).lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  return channel;
};

/** The opened business token of a channel that may manage templates (server side only). */
export const templateToken = async (
  tx: Pick<TemplateContext, 'wa'>,
  channelId: Types.ObjectId,
): Promise<{ channel: WhatsAppChannelDoc; token: string }> => {
  const channel = await WhatsAppChannelModel.findById(channelId)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  if (!MANAGING.has(channel.status) || !channel.tokenSealed) throw notReady();
  try {
    return { channel, token: openSecret(tx.wa, channel.tokenSealed) };
  } catch {
    getLogger().error(
      { channelId: channel._id.toString() },
      'templates: token could not be opened',
    );
    throw notReady();
  }
};

/** A channel of the WABA that can manage its templates (the first connected one). */
export const wabaChannel = async (
  accountId: Types.ObjectId,
  wabaId: string,
): Promise<WhatsAppChannelDoc> => {
  const channel = await WhatsAppChannelModel.findOne({
    accountId,
    wabaId,
    status: { $in: MANAGING_STATUSES },
  })
    .sort({ status: 1, createdAt: 1 })
    .lean<WhatsAppChannelDoc>();
  if (!channel) throw notReady('Connect a WhatsApp number of this account first.');
  return channel;
};

/**
 * A failed template management call → our error: an invalid token marks the number
 * `needs_reconnect`; name taken / limit / invalid content / rate get their codes.
 */
export const templateMetaError = async (
  tx: Pick<TemplateContext, 'wa'>,
  channel: WhatsAppChannelDoc,
  err: unknown,
): Promise<unknown> => {
  if (!isMetaApiError(err)) return err;
  if (err.tokenInvalid) {
    await markNeedsReconnect(tx.wa, channel, TOKEN_INVALID_REASON);
    return notReady('The WhatsApp connection expired — reconnect the number.');
  }
  const mapped = mapTemplateError(err);
  if (mapped.code === 'META_API_ERROR') return metaApiError(err);
  if (mapped.code === 'VALIDATION_FAILED') {
    return new AppError('VALIDATION_FAILED', 'WhatsApp refused the template content.', [
      { path: 'components', message: mapped.message },
    ]);
  }
  return new AppError(mapped.code, mapped.message, undefined, {
    ...(mapped.code === 'RATE_LIMITED' ? { retryAfterSec: 3600 } : {}),
  });
};
