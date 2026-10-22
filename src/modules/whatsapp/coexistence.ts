import { COEXISTENCE_SYNC_KINDS, isMetaApiError, type CoexistenceSyncKind } from '../../core/meta';
import type { SyncStatus, WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import type { WhatsAppContext } from './context';

const FIELD: Record<CoexistenceSyncKind, 'contactsSync' | 'historySync'> = {
  smb_app_state_sync: 'contactsSync',
  history: 'historySync',
};

/** Statuses a (re)request may start from (`received` is final). */
const REQUESTABLE: ReadonlySet<SyncStatus> = new Set(['not_requested', 'failed', 'declined']);

/**
 * Coexistence numbers (WhatsApp Business app): asks Meta to share the phone's contacts
 * (`smb_app_state_sync`) and then the chat history (`history`). Each request that fails
 * marks its status `failed` (the channel stays connected; "Retry sync" asks again).
 * Token errors are rethrown. Returns the new `coexistence` sub-document.
 */
export const requestCoexistenceSyncs = async (
  ctx: Pick<WhatsAppContext, 'meta'>,
  channel: WhatsAppChannelDoc,
  token: string,
): Promise<WhatsAppChannelDoc['coexistence']> => {
  const next = { ...channel.coexistence };
  if (channel.mode !== 'coexistence' || !channel.phoneNumberId) return next;
  for (const kind of COEXISTENCE_SYNC_KINDS) {
    const field = FIELD[kind];
    if (!REQUESTABLE.has(next[field])) continue;
    try {
      await ctx.meta.requestCoexistenceSync(token, channel.phoneNumberId, kind);
      next[field] = 'requested';
      if (field === 'historySync') next.historyProgress = 0;
    } catch (err) {
      if (!isMetaApiError(err) || err.tokenInvalid) throw err;
      getLogger().warn(
        { channelId: channel._id.toString(), kind, code: err.code },
        'whatsapp: coexistence sync request failed',
      );
      next[field] = 'failed';
    }
  }
  return next;
};

/** True when "Retry sync" has something to ask for. */
export const canRetryCoexistence = (channel: WhatsAppChannelDoc): boolean =>
  channel.mode === 'coexistence' &&
  (REQUESTABLE.has(channel.coexistence.contactsSync) ||
    REQUESTABLE.has(channel.coexistence.historySync));
