import type { Migration } from '../migrate';
import { WhatsAppScheduledCallModel } from '../models/whatsapp-scheduled-call.model';

/** SAC-T8: the scheduled AI WhatsApp calls collection and its indexes. Additive. */
export const waScheduledCallsMigration: Migration = {
  name: '0031-wa-scheduled-calls',
  up: async () => {
    await WhatsAppScheduledCallModel.createCollection().catch(() => undefined);
    await WhatsAppScheduledCallModel.createIndexes();
  },
  down: async (db) => {
    await db
      .collection('whatsappScheduledCalls')
      .drop()
      .catch(() => undefined);
  },
};
