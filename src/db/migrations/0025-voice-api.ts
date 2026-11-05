import type { Migration } from '../migrate';
import { CampaignContactModel } from '../models/campaign-contact.model';

/** VAPI: recorded-voice / IVR campaigns over Cell24x7 — defaults and the result lookup index. */
export const voiceApiMigration: Migration = {
  name: '0025-voice-api',
  up: async (db) => {
    await db
      .collection('accounts')
      .updateMany(
        { voiceApi: { $exists: false } },
        { $set: { voiceApi: { enabled: false, ivrIds: [], ivrEstimateSec: 60 } } },
      );
    await db
      .collection('campaigns')
      .updateMany({ voiceApi: { $exists: false } }, { $set: { voiceApi: null } });
    await CampaignContactModel.createIndexes();
  },
  down: async (db) => {
    await db
      .collection('campaignContacts')
      .dropIndex('campaign_contact_voice_result')
      .catch((error: { code?: number }) => {
        if (error.code !== 27 && error.code !== 26) throw error;
      });
  },
};
