import type { ConversationDoc } from '../../db/models/conversation.model';
import type { MessageDoc } from '../../db/models/message.model';

import { inboxNow, type InboxContext } from './context';
import { touchLastMessage } from './conversation-store';
import { emitConversation, emitMessageCreated } from './events';
import { blankContent, insertMessage } from './message-store';

/**
 * Our own text to the customer (opt-out / opt-in confirmations): `origin: system`,
 * no sender, queued for the send job. Only inside the customer service window
 * (the keyword that triggers it just opened it). Returns null when the window is closed.
 */
export const queueSystemText = async (
  ix: InboxContext,
  conversation: ConversationDoc,
  text: string,
): Promise<MessageDoc | null> => {
  const now = inboxNow(ix);
  if (!conversation.windowExpiresAt || conversation.windowExpiresAt <= now) return null;
  const message = await insertMessage(conversation, {
    ...blankContent('text'),
    text,
    direction: 'out',
    origin: 'system',
    status: 'queued',
    at: now,
    statusHistory: [{ status: 'queued', at: now }],
  });
  emitMessageCreated(message);
  const conv = await touchLastMessage(conversation._id, message);
  if (conv) emitConversation(conv);
  await ix.jobs.enqueueSend(message._id.toString());
  return message;
};
