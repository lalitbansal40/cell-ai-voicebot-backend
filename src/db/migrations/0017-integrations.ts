import type { Migration } from '../migrate';
import { ApiKeyModel } from '../models/api-key.model';
import { ApiRequestLogModel } from '../models/api-request-log.model';
import { CallModel } from '../models/call.model';
import { MessageModel } from '../models/message.model';

export const EXTERNAL_REF_INDEX = 'external_ref';

/**
 * Phase 15 integrations: API key allowlist / expiry / usage fields, `externalRef`
 * indexes on calls and messages, the API request log (TTL 7 days). Additive and
 * idempotent; no data backfill. (Contacts already have the unique per-account
 * `externalId` index since Phase 3.)
 */
export const integrationsMigration: Migration = {
  name: '0017-integrations',
  up: async (db) => {
    const keys = db.collection('apiKeys');
    await keys.updateMany({ ipAllowlist: { $exists: false } }, { $set: { ipAllowlist: [] } });
    await keys.updateMany({ expiresAt: { $exists: false } }, { $set: { expiresAt: null } });
    await keys.updateMany({ usage: { $exists: false } }, { $set: { usage: [] } });
    await ApiKeyModel.createIndexes();
    await ApiRequestLogModel.createIndexes();
    await CallModel.createIndexes();
    await MessageModel.createIndexes();
  },
  down: async (db) => {
    for (const name of ['calls', 'messages']) {
      const col = db.collection(name);
      if (await col.indexExists(EXTERNAL_REF_INDEX)) await col.dropIndex(EXTERNAL_REF_INDEX);
      await col.updateMany({}, { $unset: { externalRef: '' } });
    }
    await db
      .collection('apiKeys')
      .updateMany({}, { $unset: { ipAllowlist: '', expiresAt: '', usage: '' } });
    if ((await db.listCollections({ name: 'apiRequestLogs' }).toArray()).length)
      await db.dropCollection('apiRequestLogs');
  },
};
