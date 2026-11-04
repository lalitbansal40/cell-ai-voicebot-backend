import type { Migration } from '../migrate';
import { WhatsAppCampaignRecipientModel } from '../models/whatsapp-campaign-recipient.model';
import { WhatsAppCampaignModel } from '../models/whatsapp-campaign.model';

/**
 * Phase 19: WhatsApp campaigns + recipients get their collections and indexes; Phase 8
 * campaigns get `line: 'phone'` (they can now also run on WhatsApp). Additive only.
 */
export const whatsappCampaignsMigration: Migration = {
  name: '0022-whatsapp-campaigns',
  up: async (db) => {
    await WhatsAppCampaignModel.createIndexes();
    await WhatsAppCampaignRecipientModel.createIndexes();
    await db
      .collection('campaigns')
      .updateMany({ line: { $exists: false } }, { $set: { line: 'phone', channelId: null } });
  },
  down: async (db) => {
    await db.collection('campaigns').updateMany({}, { $unset: { line: '', channelId: '' } });
    for (const name of ['whatsappCampaigns', 'whatsappCampaignRecipients']) {
      await db
        .collection(name)
        .drop()
        .catch(() => undefined);
    }
  },
};
