import type { Migration } from '../migrate';

/**
 * PMC: `metaCalling` (calls of a managed number over Meta Graph with our app's token) on every
 * WhatsApp channel — `off` until someone turns it on. Additive and idempotent.
 */
export const waMetaCallingMigration: Migration = {
  name: '0032-wa-meta-calling',
  up: async (db) => {
    const channels = db.collection('whatsappChannels');
    await channels.updateMany(
      { metaCalling: { $exists: false } },
      {
        $set: {
          metaCalling: {
            status: 'off',
            method: null,
            tokenSealed: null,
            tokenLast4: null,
            tokenExpiresAt: null,
            scopes: [],
            metaUserId: null,
            webhookCheck: {
              status: 'unknown',
              appSubscribed: null,
              missingFields: [],
              checkedAt: null,
              fixedAt: null,
              error: null,
            },
            enabledAt: null,
            enabledBy: null,
            checkedAt: null,
            error: null,
          },
        },
      },
    );
    await channels.createIndex(
      { 'metaCalling.status': 1 },
      { name: 'metaCalling.status_1', sparse: true },
    );
  },
  down: async (db) => {
    const channels = db.collection('whatsappChannels');
    try {
      await channels.dropIndex('metaCalling.status_1');
    } catch {
      // not there
    }
    await channels.updateMany({}, { $unset: { metaCalling: '' } });
  },
};
