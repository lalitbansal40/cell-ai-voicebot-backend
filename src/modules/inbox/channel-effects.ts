import type { Types } from 'mongoose';

import type { SendErrorMapping } from '../../core/meta';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { markNeedsReconnect, SYSTEM_ACTOR, transition } from '../whatsapp/channel-status';
import type { WhatsAppContext } from '../whatsapp/context';

const RESTRICTED_REASON = {
  code: 'meta_restricted',
  message: 'Meta restricted this number — check WhatsApp Manager.',
  step: null,
};

/** A send / status error that says the number itself has a problem (190 → reconnect, 368 → restricted). */
export const applyChannelEffect = async (
  ctx: Pick<WhatsAppContext, 'env' | 'now'>,
  channelId: Types.ObjectId,
  effect: SendErrorMapping['channelEffect'],
): Promise<void> => {
  if (effect === 'none') return;
  const channel = await WhatsAppChannelModel.findById(channelId).lean<WhatsAppChannelDoc>();
  if (!channel || channel.status === 'disconnected') return;
  if (effect === 'needs_reconnect') {
    if (channel.status !== 'needs_reconnect') await markNeedsReconnect(ctx, channel);
    return;
  }
  if (channel.status === 'connected') {
    await transition(ctx, channel, 'restricted', RESTRICTED_REASON, SYSTEM_ACTOR);
  }
};
