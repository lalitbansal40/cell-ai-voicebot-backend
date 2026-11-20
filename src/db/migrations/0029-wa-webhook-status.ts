import type { Migration } from '../migrate';

/**
 * SAC-T4: `webhookCheck` (did we confirm Meta delivers this number's events to us?) on every
 * WhatsApp channel — `unknown` until the next check. Additive and idempotent.
 */
export const waWebhookStatusMigration: Migration = {
  name: '0029-wa-webhook-status',
  up: async (db) => {
    await db.collection('whatsappChannels').updateMany(
      { webhookCheck: { $exists: false } },
      {
        $set: {
          webhookCheck: {
            status: 'unknown',
            appSubscribed: null,
            missingFields: [],
            checkedAt: null,
            fixedAt: null,
            error: null,
          },
        },
      },
    );
  },
  down: async (db) => {
    await db.collection('whatsappChannels').updateMany({}, { $unset: { webhookCheck: '' } });
  },
};
