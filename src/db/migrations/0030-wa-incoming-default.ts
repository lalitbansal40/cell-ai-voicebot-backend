import type { Migration } from '../migrate';

/**
 * SAC-T6: `settings.waIncoming` (the account default for incoming WhatsApp calls) on every
 * account — the team answers, as today. Additive and idempotent.
 */
export const waIncomingDefaultMigration: Migration = {
  name: '0030-wa-incoming-default',
  up: async (db) => {
    await db
      .collection('accounts')
      .updateMany(
        { 'settings.waIncoming': { $exists: false } },
        { $set: { 'settings.waIncoming': { route: 'team', aiProgram: null, ringTimeoutSec: 30 } } },
      );
  },
  down: async (db) => {
    await db.collection('accounts').updateMany({}, { $unset: { 'settings.waIncoming': '' } });
  },
};
