import { INBOX_LIMITS } from '../../config/limits';
import type { AccountInboxSettings } from '../../db/models/account.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import type { ConversationDoc } from '../../db/models/conversation.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import { recordAudit } from '../audit/audit.service';
import { addDndEntries } from '../dnd/dnd.service';

import { inboxNow, type InboxContext } from './context';
import { emitMessageCreated } from './events';
import { matchKeyword, type KeywordMatch } from './keywords';
import { insertSystemLine } from './message-store';
import { queueSystemText } from './outbound.service';

export const WHATSAPP_DND_REASON = 'WhatsApp STOP';

const audit = (
  conversation: ConversationDoc,
  contact: ContactDoc,
  action: 'inbox.contact_opted_out' | 'inbox.contact_opted_in',
  meta: Record<string, unknown>,
) =>
  recordAudit({
    accountId: conversation.accountId,
    actor: { type: 'system', id: null },
    action,
    target: { type: 'contact', id: contact._id.toString() },
    meta: {
      conversationId: conversation._id.toString(),
      channelId: conversation.channelId.toString(),
      ...meta,
    },
  });

/** Confirmation text at most once per contact × kind per cooldown (a STOP repeated twice sends one). */
const confirm = async (
  ix: InboxContext,
  conversation: ConversationDoc,
  contact: ContactDoc,
  kind: 'opt_out' | 'opt_in',
  text: string,
) => {
  const fresh = await ix.wa.redis.set(
    `inbox-keyword-reply-${kind}-${contact._id.toString()}`,
    '1',
    'PX',
    INBOX_LIMITS.optOutReplyCooldownMs,
    'NX',
  );
  if (fresh === 'OK') await queueSystemText(ix, conversation, text);
};

/**
 * Opt-out / opt-in keywords on a customer message (PHASE_10_PLAN §1g). Opt-out:
 * `optedOutAt` + a WhatsApp DND entry + system line + audit + confirmation.
 * Opt-in: clears them (a DND entry a person added stays). Idempotent.
 */
export const handleKeywords = async (
  ix: InboxContext,
  input: {
    settings: AccountInboxSettings;
    conversation: ConversationDoc;
    contact: ContactDoc;
    text: string | null;
  },
): Promise<KeywordMatch> => {
  const { settings, conversation, contact } = input;
  const kind = matchKeyword(input.text, settings);
  if (!kind) return null;
  const now = inboxNow(ix);
  if (kind === 'opt_out') {
    if (contact.optedOutAt) return null;
    await addDndEntries(
      contact.accountId,
      [{ phoneE164: contact.phoneE164, reason: WHATSAPP_DND_REASON }],
      'whatsapp',
      null,
    );
    await ContactModel.updateOne(
      { _id: contact._id, accountId: contact.accountId },
      { $set: { optedOutAt: now, dnd: true } },
    );
    emitMessageCreated(await insertSystemLine(conversation, 'opted_out', now));
    await audit(conversation, contact, 'inbox.contact_opted_out', { kind });
    if (settings.optOutReply)
      await confirm(ix, conversation, contact, kind, settings.optOutReplyText);
    return kind;
  }
  if (!contact.optedOutAt) return null;
  await DndEntryModel.deleteOne({
    accountId: contact.accountId,
    phoneE164: contact.phoneE164,
    source: 'whatsapp',
  });
  const dndKept = Boolean(
    await DndEntryModel.exists({ accountId: contact.accountId, phoneE164: contact.phoneE164 }),
  );
  if (!dndKept) {
    await ContactModel.updateMany(
      { accountId: contact.accountId, phoneE164: contact.phoneE164 },
      { $set: { dnd: false } },
      { withDeleted: true } as never,
    );
  }
  await ContactModel.updateOne(
    { _id: contact._id, accountId: contact.accountId },
    { $set: { optedOutAt: null, dnd: dndKept } },
  );
  emitMessageCreated(
    await insertSystemLine(conversation, dndKept ? 'opted_in_dnd_kept' : 'opted_in', now),
  );
  await audit(conversation, contact, 'inbox.contact_opted_in', { kind, dndKept });
  if (settings.optInReply) await confirm(ix, conversation, contact, kind, settings.optInReplyText);
  return kind;
};
