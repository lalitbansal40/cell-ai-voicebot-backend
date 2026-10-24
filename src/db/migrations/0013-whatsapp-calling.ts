import type { Db } from 'mongodb';

import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { DEFAULT_WHATSAPP_CALLING_SETTINGS } from '../models/account.model';
import { CallModel } from '../models/call.model';
import { ContactModel } from '../models/contact.model';
import { MessageModel } from '../models/message.model';
import { DEFAULT_WHATSAPP_CALLING_SETTINGS as DEFAULT_PLATFORM_CALLING } from '../models/platform-settings.model';
import { WhatsAppCallPermissionModel } from '../models/whatsapp-call-permission.model';
import { defaultCalling } from '../models/whatsapp-channel.model';
import {
  PLACEHOLDER_CALLING_MARKETS,
  PLACEHOLDER_CALLING_RATE_CARD_NOTE,
  WhatsAppRateCardModel,
} from '../models/whatsapp-rate-card.model';

export const CALLING_COLLECTIONS = ['whatsappCallPermissions'] as const;
export const CALLING_PERMISSIONS = ['calls.answer', 'whatsapp.calling.manage'] as const;
/** Named indexes this migration adds to existing collections (dropped on the way down). */
export const CALLING_INDEXES = {
  calls: ['wa_call_id', 'wa_channel_calls'],
  messages: ['call_bubble'],
  contacts: ['whatsapp_bsuid'],
  whatsappRateCards: ['kind_effective_from'],
} as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

const hasCollection = (db: Db, name: string) =>
  db.listCollections({ name }, { nameOnly: true }).hasNext();

/**
 * Phase 12: the call permission collection, WhatsApp call indexes (calls, call
 * bubbles, BSUID), channel `calling` defaults (coexistence numbers unavailable),
 * the placeholder INR calling rate card (IN + OTHER), the platform call price
 * settings, account call settings (recording notice from the Phase 7 notice), the
 * users' call availability and the two new permissions on the system roles.
 */
export const whatsappCallingMigration: Migration = {
  name: '0013-whatsapp-calling',
  up: async (db) => {
    for (const name of CALLING_COLLECTIONS) await ensureCollection(db, name);
    await WhatsAppCallPermissionModel.createIndexes();
    await CallModel.createIndexes();
    await MessageModel.createIndexes();
    await ContactModel.createIndexes();
    await WhatsAppRateCardModel.createIndexes();

    const now = new Date();
    const channels = db.collection('whatsappChannels');
    await channels.updateMany(
      { calling: { $exists: false }, mode: 'coexistence' },
      { $set: { calling: defaultCalling('coexistence') } },
    );
    await channels.updateMany(
      { calling: { $exists: false } },
      { $set: { calling: defaultCalling() } },
    );

    const cards = db.collection('whatsappRateCards');
    await cards.updateMany(
      { kind: { $exists: false } },
      { $set: { kind: 'messaging', callingMarkets: [] } },
    );
    if (!(await cards.countDocuments({ kind: 'calling' }, { limit: 1 }))) {
      await cards.insertOne({
        kind: 'calling',
        effectiveFrom: now,
        currency: 'INR',
        source: 'manual',
        note: PLACEHOLDER_CALLING_RATE_CARD_NOTE,
        createdBy: null,
        markets: [],
        callingMarkets: structuredClone(PLACEHOLDER_CALLING_MARKETS),
        createdAt: now,
        updatedAt: now,
      });
    }

    await db.collection('platformSettings').updateOne(
      { key: 'whatsappCalling' },
      {
        $setOnInsert: {
          key: 'whatsappCalling',
          value: { ...DEFAULT_PLATFORM_CALLING },
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    // the account's own recording notice (Phase 7) is said on WhatsApp calls too
    await db.collection('accounts').updateMany({ 'settings.whatsappCalling': { $exists: false } }, [
      {
        $set: {
          'settings.whatsappCalling': {
            recordCalls: DEFAULT_WHATSAPP_CALLING_SETTINGS.recordCalls,
            recordingNotice: {
              $ifNull: [
                '$settings.recordingNotice',
                DEFAULT_WHATSAPP_CALLING_SETTINGS.recordingNotice,
              ],
            },
            transcribeHumanCalls: DEFAULT_WHATSAPP_CALLING_SETTINGS.transcribeHumanCalls,
            maxCallMinutes: DEFAULT_WHATSAPP_CALLING_SETTINGS.maxCallMinutes,
          },
        },
      },
    ]);
    await db
      .collection('users')
      .updateMany(
        { callAvailability: { $exists: false } },
        { $set: { callAvailability: 'available' } },
      );
    await syncAllSystemRoles();
  },
  down: async (db) => {
    const charges = await db
      .collection('ledgerEntries')
      .countDocuments({ type: 'whatsapp_call_charge' }, { limit: 1 });
    const calls = (await hasCollection(db, 'calls'))
      ? await db.collection('calls').countDocuments({ provider: 'whatsapp' }, { limit: 1 })
      : 0;
    if (charges || calls) {
      throw new Error('0013-whatsapp-calling: refusing to roll back — WhatsApp calls exist');
    }
    for (const name of CALLING_COLLECTIONS) {
      if (await hasCollection(db, name)) await db.collection(name).drop();
    }
    for (const [collection, names] of Object.entries(CALLING_INDEXES)) {
      if (!(await hasCollection(db, collection))) continue;
      for (const index of names) {
        if (await db.collection(collection).indexExists(index)) {
          await db.collection(collection).dropIndex(index);
        }
      }
    }
    await db.collection('whatsappChannels').updateMany({}, { $unset: { calling: '' } });
    await db.collection('whatsappRateCards').deleteMany({ kind: 'calling' });
    await db
      .collection('whatsappRateCards')
      .updateMany({}, { $unset: { kind: '', callingMarkets: '' } });
    await db.collection('platformSettings').deleteOne({ key: 'whatsappCalling' });
    await db
      .collection('accounts')
      .updateMany({}, { $unset: { 'settings.whatsappCalling': '', whatsappCallingBilling: '' } });
    await db.collection('users').updateMany({}, { $unset: { callAvailability: '' } });
    await db.collection('contacts').updateMany({}, { $unset: { 'whatsapp.bsuid': '' } });
    await db.collection('roles').updateMany({ isSystem: true }, {
      $pull: { permissions: { $in: [...CALLING_PERMISSIONS] } },
    } as never);
  },
};
