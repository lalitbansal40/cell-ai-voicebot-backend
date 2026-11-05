import type { Migration } from '../migrate';
import { WhatsAppCampaignModel } from '../models/whatsapp-campaign.model';

/** Additive recurrence metadata/index; old code can still read existing campaigns. */
export const waCampaignRunsMigration: Migration = {
  name: '0023-wa-campaign-runs',
  up: async (db) => {
    await WhatsAppCampaignModel.createIndexes();
    await db.collection('whatsappCampaignRecipients').updateMany(
      {
        $or: [{ status: { $in: ['sent', 'delivered', 'read'] } }, { sentAt: { $type: 'date' } }],
        sentCounted: { $exists: false },
      },
      { $set: { sentCounted: true } },
    );
    await db
      .collection('whatsappCampaigns')
      .updateMany(
        { recurrenceEnabled: { $exists: false } },
        { $set: { recurrenceEnabled: true, parentCampaignId: null, headerMedia: null } },
      );
  },
  down: async (db) => {
    await db
      .collection('whatsappCampaigns')
      .dropIndex('wa_recurring_run')
      .catch((err: { code?: number }) => {
        if (err.code !== 27 && err.code !== 26) throw err;
      });
  },
};
