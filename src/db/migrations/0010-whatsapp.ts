import type { Db } from 'mongodb';

import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { DEFAULT_ACCOUNT_WHATSAPP } from '../models/account.model';
import { MetaDeletionRequestModel } from '../models/meta-deletion-request.model';
import { MetaWebhookEventModel } from '../models/meta-webhook-event.model';
import { WhatsAppChannelModel } from '../models/whatsapp-channel.model';

export const WHATSAPP_COLLECTIONS = [
  'whatsappChannels',
  'metaWebhookEvents',
  'metaDeletionRequests',
] as const;

export const WHATSAPP_PERMISSIONS = ['whatsapp.read', 'whatsapp.manage'] as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/**
 * Phase 9: WhatsApp channel + Meta webhook / data-deletion collections and
 * indexes, the account's Meta billing mode (default: platform credit line) and
 * the `whatsapp.*` permissions on the system roles.
 */
export const whatsappMigration: Migration = {
  name: '0010-whatsapp',
  up: async (db) => {
    for (const name of WHATSAPP_COLLECTIONS) await ensureCollection(db, name);
    await WhatsAppChannelModel.createIndexes();
    await MetaWebhookEventModel.createIndexes();
    await MetaDeletionRequestModel.createIndexes();
    await db
      .collection('accounts')
      .updateMany(
        { 'whatsapp.metaPayer': { $exists: false } },
        { $set: { 'whatsapp.metaPayer': DEFAULT_ACCOUNT_WHATSAPP.metaPayer } },
      );
    await syncAllSystemRoles();
  },
  down: async (db) => {
    const channels = await db
      .collection('whatsappChannels')
      .countDocuments({ status: { $ne: 'disconnected' } }, { limit: 1 });
    if (channels) {
      throw new Error('0010-whatsapp: refusing to roll back — WhatsApp numbers are connected');
    }
    for (const name of WHATSAPP_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
    await db.collection('accounts').updateMany({}, { $unset: { whatsapp: '' } });
    await db.collection('roles').updateMany({ isSystem: true }, {
      $pull: { permissions: { $in: [...WHATSAPP_PERMISSIONS] } },
    } as never);
  },
};
