import type { Types } from 'mongoose';

import { isProviderBalanceLow } from '../../core/meta';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { notifyPlatform } from '../notifications/notifications.service';

import type { WhatsAppContext } from './context';

/** Superadmin bell at most once an hour for the whole platform (one partner wallet). */
const ALERT_KEY = 'wa:pinnacle:balance-alert';
const ALERT_TTL_SEC = 3600;

/**
 * PN (D13): a managed number hit "Insufficient Balance" at the partner. Remembers it on the
 * channel and rings the superadmins (throttled). The channel stays connected.
 */
export const recordPinnacleBalanceLow = async (
  ctx: Pick<WhatsAppContext, 'redis' | 'now'>,
  channelId: Types.ObjectId,
): Promise<void> => {
  const now = ctx.now?.() ?? new Date();
  await WhatsAppChannelModel.updateOne(
    { _id: channelId, provider: 'pinnacle', pinnacle: { $type: 'object' } },
    { $set: { 'pinnacle.lastBalanceErrorAt': now } },
  ).catch(() => undefined);
  getLogger().warn(
    { metric: 'pinnacle_balance_low', channelId: channelId.toString() },
    'pinnacle: partner balance low',
  );
  const first = await ctx.redis.set(ALERT_KEY, '1', 'EX', ALERT_TTL_SEC, 'NX').catch(() => null);
  if (first !== 'OK') return;
  await notifyPlatform({
    type: 'whatsapp.provider_balance_low',
    title: 'Partner WhatsApp balance is low',
    body: 'Messages and calls on managed WhatsApp numbers are failing — top up the partner (Pinnacle) wallet.',
    link: '/admin/whatsapp',
  }).catch(() => 0);
};

/** Records the alert when `err` is the partner's balance error (any other error: nothing). */
export const noteProviderError = async (
  ctx: Pick<WhatsAppContext, 'redis' | 'now'>,
  channelId: Types.ObjectId,
  err: unknown,
): Promise<void> => {
  if (isProviderBalanceLow(err)) await recordPinnacleBalanceLow(ctx, channelId);
};
