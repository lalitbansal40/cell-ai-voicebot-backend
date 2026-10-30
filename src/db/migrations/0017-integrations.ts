import type { Migration } from '../migrate';
import { ApiKeyModel } from '../models/api-key.model';
import { ApiRequestLogModel } from '../models/api-request-log.model';
import { CallModel } from '../models/call.model';
import { MessageModel } from '../models/message.model';
import { OutcomeRuleModel } from '../models/outcome-rule.model';
import { PostCallMessageModel } from '../models/post-call-message.model';
import { SheetImportModel } from '../models/sheet-import.model';
import { WebhookDeliveryModel } from '../models/webhook-delivery.model';
import { WebhookEndpointModel } from '../models/webhook-endpoint.model';
import { WebhookEventModel } from '../models/webhook-event.model';

export const EXTERNAL_REF_INDEX = 'external_ref';

/**
 * Phase 15 integrations: API key allowlist / expiry / usage fields, `externalRef`
 * indexes on calls and messages, the API request log (TTL 7 days). Additive and
 * idempotent; no data backfill. T15.3: the webhook collections and their indexes. (Contacts already have the unique per-account
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
    // webhooks (T15.3): endpoints, the outbox and the delivery log (TTL 30 days)
    await WebhookEndpointModel.createIndexes();
    await WebhookEventModel.createIndexes();
    await WebhookDeliveryModel.createIndexes();
    // after the call (T15.5): rules and the messages they / flows schedule
    await OutcomeRuleModel.createIndexes();
    await PostCallMessageModel.createIndexes();
    // Google-Sheet imports (T15.6)
    await SheetImportModel.createIndexes();
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
    for (const name of [
      'apiRequestLogs',
      'webhookEndpoints',
      'webhookEvents',
      'webhookDeliveries',
      'outcomeRules',
      'postCallMessages',
      'sheetImports',
    ]) {
      if ((await db.listCollections({ name }).toArray()).length) await db.dropCollection(name);
    }
  },
};
