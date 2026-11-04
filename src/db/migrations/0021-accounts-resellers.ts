import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { AccountModel } from '../models/account.model';
import { DEFAULT_SIGNUP_SETTINGS } from '../models/platform-settings.model';

/**
 * Phase 19: every account gets a `kind` (platform account → `platform`, else `business`) and
 * no parent; owners who signed up but never entered the e-mail code are verified (signup no
 * longer sends e-mail); the `signup` platform setting gets its default row. Additive only,
 * so the previous release keeps working.
 */
export const accountsResellersMigration: Migration = {
  name: '0021-accounts-resellers',
  up: async (db) => {
    await AccountModel.createIndexes();
    // 4 new permissions in the system roles (reseller.*, whatsapp_campaigns.*)
    await syncAllSystemRoles();
    const accounts = db.collection('accounts');
    await accounts.updateMany(
      { kind: { $exists: false }, isPlatform: true },
      { $set: { kind: 'platform', parentAccountId: null, reseller: null } },
    );
    await accounts.updateMany(
      { kind: { $exists: false } },
      { $set: { kind: 'business', parentAccountId: null, reseller: null } },
    );
    await db
      .collection('users')
      .updateMany({ status: 'active', emailVerifiedAt: null }, [
        { $set: { emailVerifiedAt: '$createdAt' } },
      ]);
    const now = new Date();
    await db.collection('platformSettings').updateOne(
      { key: 'signup' },
      {
        $setOnInsert: {
          key: 'signup',
          value: { ...DEFAULT_SIGNUP_SETTINGS },
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  },
  down: async (db) => {
    await db
      .collection('accounts')
      .updateMany({}, { $unset: { kind: '', parentAccountId: '', reseller: '' } });
    await db.collection('platformSettings').deleteOne({ key: 'signup' });
  },
};
