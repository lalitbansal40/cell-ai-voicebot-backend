import type { Migration } from '../migrate';

/** CM: who talks on call campaigns (existing campaigns are AI) — defaults only. */
export const callModesMigration: Migration = {
  name: '0027-call-modes',
  up: async (db) => {
    await db
      .collection('campaigns')
      .updateMany({ talkMode: { $exists: false } }, { $set: { talkMode: 'ai', team: null } });
  },
  down: async () => {
    // additive defaults; nothing to undo
  },
};
