import type { Db } from 'mongodb';

import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { DEFAULT_ACCOUNT_LIMITS, DEFAULT_ACCOUNT_SETTINGS } from '../models/account.model';
import { CallModel } from '../models/call.model';
import { CampaignContactModel } from '../models/campaign-contact.model';
import { CampaignModel } from '../models/campaign.model';

export const CAMPAIGN_COLLECTIONS = ['campaigns', 'campaignContacts'] as const;

/** Call indexes added in Phase 8 (dropped again on rollback). */
export const PHASE8_CALL_INDEXES = [
  'campaignContactId_1_attempt_1',
  'accountId_1_contactId_1_provider_1_createdAt_-1',
] as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/**
 * Phase 8: campaign collections + indexes, the call indexes for campaign attempts,
 * account dialing limits + per-contact call caps, export job kinds, and the
 * `campaigns.export` permission on the system roles.
 */
export const campaignsMigration: Migration = {
  name: '0009-campaigns',
  up: async (db) => {
    for (const name of CAMPAIGN_COLLECTIONS) await ensureCollection(db, name);
    await CampaignModel.createIndexes();
    await CampaignContactModel.createIndexes();
    await CallModel.createIndexes();
    const accounts = db.collection('accounts');
    await accounts.updateMany(
      { limits: { $exists: false } },
      { $set: { limits: { ...DEFAULT_ACCOUNT_LIMITS } } },
    );
    await accounts.updateMany(
      { 'settings.callCaps': { $exists: false } },
      { $set: { 'settings.callCaps': { ...DEFAULT_ACCOUNT_SETTINGS.callCaps } } },
    );
    await db
      .collection('exportJobs')
      .updateMany(
        { kind: { $exists: false } },
        { $set: { kind: 'contacts', campaignId: null, format: 'csv', includePhone: true } },
      );
    await syncAllSystemRoles();
  },
  down: async (db) => {
    const campaigns = await db.collection('campaigns').countDocuments({}, { limit: 1 });
    if (campaigns) throw new Error('0009-campaigns: refusing to roll back — campaigns exist');
    for (const name of CAMPAIGN_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
    const callIndexes = (await db.collection('calls').indexes()).map((i) => i.name);
    for (const name of PHASE8_CALL_INDEXES) {
      if (callIndexes.includes(name)) await db.collection('calls').dropIndex(name);
    }
    await db
      .collection('accounts')
      .updateMany({}, { $unset: { limits: '', 'settings.callCaps': '' } });
    await db
      .collection('exportJobs')
      .updateMany({}, { $unset: { kind: '', campaignId: '', format: '', includePhone: '' } });
    await db
      .collection('roles')
      .updateMany({ isSystem: true }, { $pull: { permissions: 'campaigns.export' } } as never);
  },
};
