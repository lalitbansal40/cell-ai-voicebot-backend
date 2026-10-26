import type { Migration } from '../migrate';
import { WhatsAppChannelModel } from '../models/whatsapp-channel.model';

export const META_2026_INDEX = 'account_waac';

/**
 * Phase 13: Meta's 2026 account model — channels gain `wabaKind` (null = unknown) and
 * `waacId` (the WhatsApp account id when Meta sends it apart from the Messaging
 * account). Additive; nothing is backfilled.
 */
export const meta2026Migration: Migration = {
  name: '0014-meta-2026',
  up: async (db) => {
    await db
      .collection('whatsappChannels')
      .updateMany({ wabaKind: { $exists: false } }, { $set: { wabaKind: null } });
    await db
      .collection('whatsappChannels')
      .updateMany({ waacId: { $exists: false } }, { $set: { waacId: null } });
    await WhatsAppChannelModel.createIndexes();
  },
  down: async (db) => {
    const channels = db.collection('whatsappChannels');
    if (await channels.indexExists(META_2026_INDEX)) await channels.dropIndex(META_2026_INDEX);
    await channels.updateMany({}, { $unset: { wabaKind: '', waacId: '' } });
  },
};
