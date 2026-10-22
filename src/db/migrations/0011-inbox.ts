import type { Db } from 'mongodb';

import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { DEFAULT_INBOX_SETTINGS } from '../models/account.model';
import { ConversationModel } from '../models/conversation.model';
import { InboxUploadModel } from '../models/inbox-upload.model';
import { MessageModel } from '../models/message.model';

export const INBOX_COLLECTIONS = ['conversations', 'messages', 'inboxUploads'] as const;

export const INBOX_PERMISSIONS = ['inbox.read', 'inbox.reply', 'inbox.assign'] as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/**
 * Phase 10: WhatsApp inbox collections + indexes, the accounts' inbox settings
 * (owner defaults of 23 Oct 2026) and the `inbox.*` permissions on the system roles.
 * Webhook events stored as `deferred` before this deploy are processed by the
 * `inbox.backfill` job, which the WhatsApp worker queues at start when any exist.
 */
export const inboxMigration: Migration = {
  name: '0011-inbox',
  up: async (db) => {
    for (const name of INBOX_COLLECTIONS) await ensureCollection(db, name);
    await ConversationModel.createIndexes();
    await MessageModel.createIndexes();
    await InboxUploadModel.createIndexes();
    await db
      .collection('accounts')
      .updateMany(
        { 'settings.inbox': { $exists: false } },
        { $set: { 'settings.inbox': structuredClone(DEFAULT_INBOX_SETTINGS) } },
      );
    await syncAllSystemRoles();
  },
  down: async (db) => {
    const messages = await db.collection('messages').countDocuments({}, { limit: 1 });
    if (messages) {
      throw new Error('0011-inbox: refusing to roll back — WhatsApp messages exist');
    }
    for (const name of INBOX_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
    await db.collection('accounts').updateMany({}, { $unset: { 'settings.inbox': '' } });
    await db.collection('contacts').updateMany({}, { $unset: { whatsapp: '' } });
    await db.collection('roles').updateMany({ isSystem: true }, {
      $pull: { permissions: { $in: [...INBOX_PERMISSIONS] } },
    } as never);
  },
};
