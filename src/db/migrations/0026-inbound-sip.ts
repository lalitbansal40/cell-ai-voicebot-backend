import type { Migration } from '../migrate';
import { CallModel } from '../models/call.model';
import { defaultInbound } from '../models/phone-number.model';

/** Phase 20: incoming phone calls — number settings (off) and the missed-calls index. */
export const inboundSipMigration: Migration = {
  name: '0026-inbound-sip',
  up: async (db) => {
    await db
      .collection('phoneNumbers')
      .updateMany({ inbound: { $exists: false } }, { $set: { inbound: defaultInbound() } });
    await CallModel.createIndexes();
  },
  down: async (db) => {
    await db
      .collection('calls')
      .dropIndex('missed_calls')
      .catch((error: { code?: number }) => {
        if (error.code !== 27 && error.code !== 26) throw error;
      });
  },
};
