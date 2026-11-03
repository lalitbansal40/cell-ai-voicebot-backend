import type { Migration } from '../migrate';
import { PhoneNumberModel } from '../models/phone-number.model';

/**
 * Phase 18: every account starts on the test line (`voiceLine: 'dryrun'`) with no SIP
 * overrides; caller-ID numbers get their collection and indexes. Additive only, so the
 * previous release keeps working.
 */
export const sipLinesMigration: Migration = {
  name: '0019-sip-lines',
  up: async (db) => {
    await PhoneNumberModel.createIndexes();
    await db
      .collection('accounts')
      .updateMany({ voiceLine: { $exists: false } }, { $set: { voiceLine: 'dryrun' } });
    await db
      .collection('accounts')
      .updateMany(
        { sipSettings: { $exists: false } },
        { $set: { sipSettings: { pulseSec: null, spendMinutesPerHour: null } } },
      );
  },
  down: async (db) => {
    await db.collection('accounts').updateMany({}, { $unset: { voiceLine: '', sipSettings: '' } });
    await db
      .collection('phoneNumbers')
      .drop()
      .catch(() => undefined);
  },
};
