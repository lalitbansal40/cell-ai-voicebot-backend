import type { Migration } from '../migrate';
import { CampaignModel } from '../models/campaign.model';

export const whatsappCallCampaignsMigration: Migration = {
  name: '0024-whatsapp-call-campaigns',
  up: async (db) => {
    await db
      .collection('campaigns')
      .updateMany({ line: { $exists: false } }, { $set: { line: 'phone', channelId: null } });
    await db
      .collection('campaigns')
      .updateMany(
        { program: { $exists: false } },
        { $set: { program: null, askPermissionFirst: null } },
      );
    await CampaignModel.createIndexes();
  },
  down: async (db) => {
    await db
      .collection('campaigns')
      .dropIndex('campaign_line_status')
      .catch((error: { code?: number }) => {
        if (error.code !== 27 && error.code !== 26) throw error;
      });
  },
};
