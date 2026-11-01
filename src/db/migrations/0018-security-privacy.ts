import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { AccountExportModel } from '../models/account-export.model';
import { EraseJobModel } from '../models/erase-job.model';
import { SuppressionModel } from '../models/suppression.model';

/**
 * Phase 16: indexes for suppressions, account exports and erase jobs, and defaults on
 * custom fields, accounts and users. Additive; no data is rewritten.
 */
export const securityPrivacyMigration: Migration = {
  name: '0018-security-privacy',
  up: async (db) => {
    await syncAllSystemRoles(); // contacts.erase, account.export, account.delete
    await SuppressionModel.createIndexes();
    await AccountExportModel.createIndexes();
    await EraseJobModel.createIndexes();
    await db
      .collection('customFieldDefinitions')
      .updateMany({ sensitive: { $exists: false } }, { $set: { sensitive: false } });
    await db
      .collection('accounts')
      .updateMany({ apiLimits: { $exists: false } }, { $set: { apiLimits: null, deletion: null } });
    await db.collection('users').updateMany({ mfa: { $exists: false } }, { $set: { mfa: null } });
  },
  down: async (db) => {
    await db.collection('roles').updateMany({ isSystem: true }, {
      $pull: { permissions: { $in: ['contacts.erase', 'account.export', 'account.delete'] } },
    } as never);
    await db
      .collection('customFieldDefinitions')
      .updateMany({}, { $unset: { sensitive: '', sensitiveJob: '' } });
    await db.collection('accounts').updateMany({}, { $unset: { apiLimits: '', deletion: '' } });
    await db.collection('users').updateMany({}, { $unset: { mfa: '' } });
    for (const name of ['suppressions', 'accountExports', 'eraseJobs']) {
      await db
        .collection(name)
        .drop()
        .catch(() => undefined);
    }
  },
};
