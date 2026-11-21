import { META_CALL_DIAG } from '../../config/limits';
import type { Migration } from '../migrate';

/** WCF: expiring, account-scoped Meta calling errors for panel diagnostics. */
export const metaCallErrorsMigration: Migration = {
  name: '0033-meta-call-errors',
  up: async (db) => {
    await db.collection('metaCallErrors').createIndexes([
      { key: { at: 1 }, name: 'at_1', expireAfterSeconds: META_CALL_DIAG.errorTtlDays * 86_400 },
      { key: { channelId: 1, at: -1 }, name: 'channelId_1_at_-1' },
      { key: { accountId: 1, at: -1 }, name: 'accountId_1_at_-1' },
    ]);
  },
  down: async (db) => {
    await db.dropCollection('metaCallErrors').catch(() => undefined);
  },
};
