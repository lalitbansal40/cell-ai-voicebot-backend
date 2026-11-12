import type { Migration } from '../migrate';
import { MetaWebhookEventModel } from '../models/meta-webhook-event.model';
import { WhatsAppChannelModel } from '../models/whatsapp-channel.model';

/**
 * PN: managed WhatsApp numbers over the Pinnacle partner API — `pinnacle: null` on every
 * existing channel, `source: 'meta'` on stored webhook events, and the provider index.
 * Additive and idempotent.
 */
export const pinnacleProviderMigration: Migration = {
  name: '0028-pinnacle-provider',
  up: async (db) => {
    await db
      .collection('whatsappChannels')
      .updateMany({ pinnacle: { $exists: false } }, { $set: { pinnacle: null } });
    await db
      .collection('metaWebhookEvents')
      .updateMany({ source: { $exists: false } }, { $set: { source: 'meta' } });
    await WhatsAppChannelModel.createIndexes();
    await MetaWebhookEventModel.createIndexes();
  },
  down: async (db) => {
    await db.collection('whatsappChannels').updateMany({}, { $unset: { pinnacle: '' } });
    await db.collection('metaWebhookEvents').updateMany({}, { $unset: { source: '' } });
    await db
      .collection('whatsappChannels')
      .dropIndex('provider_1_status_1')
      .catch(() => undefined);
  },
};
