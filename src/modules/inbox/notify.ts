import { INBOX_LIMITS } from '../../config/limits';
import type { InboxNotifyMode } from '../../db/models/account.model';
import type { ContactDoc } from '../../db/models/contact.model';
import type { ConversationDoc } from '../../db/models/conversation.model';
import { notify } from '../notifications/notifications.service';

import type { InboxContext } from './context';

export const inboxLink = (conversation: Pick<ConversationDoc, '_id'>): string =>
  `/inbox/${conversation._id.toString()}`;

/** "+91 •••• 1234" — the bell never shows a full customer number or the message text. */
export const maskedPhone = (phoneE164: string): string => {
  const d = phoneE164.replace(/\D/g, '');
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : '';
  return `${cc ? `+${cc} ` : ''}•••• ${d.slice(-4)}`;
};

export const contactLabel = (
  contact: Pick<ContactDoc, 'name' | 'phoneE164'> | null,
  phoneE164: string,
) => contact?.name?.trim() || maskedPhone(contact?.phoneE164 ?? phoneE164);

/**
 * New-message bell (owner decision: title + contact name + link, never the text):
 * the assignee, else (mode `assigned_or_all`) everyone who can reply; at most
 * once per conversation per `notificationThrottleMs`.
 */
export const notifyNewMessage = async (
  ix: InboxContext,
  input: { conversation: ConversationDoc; contact: ContactDoc | null; mode: InboxNotifyMode },
): Promise<number> => {
  const { conversation, mode } = input;
  if (mode === 'off') return 0;
  if (!conversation.assignedTo && mode === 'assigned_only') return 0;
  const fresh = await ix.wa.redis.set(
    `inbox-notify-${conversation._id.toString()}`,
    '1',
    'PX',
    INBOX_LIMITS.notificationThrottleMs,
    'NX',
  );
  if (fresh !== 'OK') return 0;
  return notify({
    accountId: conversation.accountId,
    ...(conversation.assignedTo
      ? { userIds: [conversation.assignedTo] }
      : { permission: 'inbox.reply' }),
    type: 'inbox.message_received',
    title: 'New WhatsApp message',
    body: contactLabel(input.contact, conversation.phoneE164),
    link: inboxLink(conversation),
  });
};
