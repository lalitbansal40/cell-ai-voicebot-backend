import type { InboxHooks } from '../whatsapp/webhook-handlers';

import { processEchoes, processStateSync } from './coexistence-import';
import type { InboxContext } from './context';
import { processMessagesValue } from './inbound.service';

/** The inbox consumers the WhatsApp worker hands to its webhook handlers. */
export const createInboxHooks = (ix: InboxContext): InboxHooks => ({
  messages: (channel, value) => processMessagesValue(ix, channel, value),
  echoes: (channel, value) => processEchoes(ix, channel, value),
  stateSync: (channel, value) => processStateSync(ix, channel, value),
  history: (_channel, eventId) => ix.jobs.enqueueHistoryImport(eventId),
});
