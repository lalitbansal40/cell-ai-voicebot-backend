import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';

import { notifyChannel, numberName } from './channel-status';
import type { WhatsAppContext } from './context';

/**
 * PMC (D14): the Meta access for a managed number's calls stopped working — one bell to the
 * owners / admins per on → error change (the callers check the change). Never throws.
 */
export const noteMetaCallingBroken = (
  ctx: Pick<WhatsAppContext, 'env' | 'now'>,
  channel: WhatsAppChannelDoc,
): Promise<void> =>
  notifyChannel(
    ctx,
    channel,
    'whatsapp.meta_calling_broken',
    'WhatsApp calls stopped on a number',
    `${numberName(channel)}: the Meta access for calls stopped working, so calls won't ring. Open the number → Calling → Check / Fix, or turn calling on again.`,
  );
