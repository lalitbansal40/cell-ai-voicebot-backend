import type { Db } from 'mongodb';

import { syncAllSystemRoles } from '../../modules/rbac/roles.service';
import type { Migration } from '../migrate';
import { DEFAULT_TEMPLATE_SETTINGS } from '../models/account.model';
import { MessageModel } from '../models/message.model';
import {
  DEFAULT_WHATSAPP_BILLING_SETTINGS,
  PlatformSettingsModel,
} from '../models/platform-settings.model';
import { WhatsAppBillingDailyModel } from '../models/whatsapp-billing-daily.model';
import {
  PLACEHOLDER_MARKETS,
  PLACEHOLDER_RATE_CARD_NOTE,
  WhatsAppRateCardModel,
} from '../models/whatsapp-rate-card.model';
import { WhatsAppTemplateModel } from '../models/whatsapp-template.model';

export const TEMPLATE_BILLING_COLLECTIONS = [
  'whatsappTemplates',
  'whatsappRateCards',
  'platformSettings',
  'whatsappBillingDaily',
] as const;

export const TEMPLATE_PERMISSIONS = ['templates.read', 'templates.manage'] as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/**
 * Phase 11: template + WhatsApp billing collections and indexes, the global WhatsApp
 * price settings, the placeholder INR rate card (IN + OTHER, until the owner imports
 * Meta's card), the accounts' template settings, the wallets' WhatsApp budget / spend
 * fields and the `templates.*` permissions on the system roles.
 */
export const templatesBillingMigration: Migration = {
  name: '0012-templates-billing',
  up: async (db) => {
    for (const name of TEMPLATE_BILLING_COLLECTIONS) await ensureCollection(db, name);
    await WhatsAppTemplateModel.createIndexes();
    await WhatsAppRateCardModel.createIndexes();
    await PlatformSettingsModel.createIndexes();
    await WhatsAppBillingDailyModel.createIndexes();
    await MessageModel.createIndexes();

    const now = new Date();
    await db.collection('platformSettings').updateOne(
      { key: 'whatsappBilling' },
      {
        $setOnInsert: {
          key: 'whatsappBilling',
          value: { ...DEFAULT_WHATSAPP_BILLING_SETTINGS },
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    if (!(await db.collection('whatsappRateCards').countDocuments({}, { limit: 1 }))) {
      await db.collection('whatsappRateCards').insertOne({
        effectiveFrom: now,
        currency: 'INR',
        source: 'manual',
        note: PLACEHOLDER_RATE_CARD_NOTE,
        createdBy: null,
        markets: structuredClone(PLACEHOLDER_MARKETS),
        createdAt: now,
        updatedAt: now,
      });
    }

    await db
      .collection('accounts')
      .updateMany(
        { 'settings.templates': { $exists: false } },
        { $set: { 'settings.templates': { ...DEFAULT_TEMPLATE_SETTINGS } } },
      );
    await db
      .collection('wallets')
      .updateMany(
        { 'budgets.monthlyWhatsappMicros': { $exists: false } },
        { $set: { 'budgets.monthlyWhatsappMicros': 0 } },
      );
    await db
      .collection('wallets')
      .updateMany(
        { 'spend.whatsappMicros': { $exists: false } },
        { $set: { 'spend.whatsappMicros': 0 } },
      );
    await syncAllSystemRoles();
  },
  down: async (db) => {
    const charges = await db
      .collection('ledgerEntries')
      .countDocuments({ type: 'whatsapp_charge' }, { limit: 1 });
    if (charges) {
      throw new Error('0012-templates-billing: refusing to roll back — WhatsApp charges exist');
    }
    for (const name of TEMPLATE_BILLING_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.collection(name).drop();
    }
    for (const index of ['billing_held_at', 'template_contact_at']) {
      const exists = await db.listCollections({ name: 'messages' }, { nameOnly: true }).hasNext();
      if (exists && (await db.collection('messages').indexExists(index))) {
        await db.collection('messages').dropIndex(index);
      }
    }
    await db
      .collection('accounts')
      .updateMany({}, { $unset: { 'settings.templates': '', whatsappBilling: '' } });
    await db
      .collection('wallets')
      .updateMany(
        {},
        { $unset: { 'budgets.monthlyWhatsappMicros': '', 'spend.whatsappMicros': '' } },
      );
    await db.collection('contacts').updateMany({}, { $unset: { 'whatsapp.marketing': '' } });
    await db.collection('whatsappChannels').updateMany({}, { $unset: { pricingTier: '' } });
    await db.collection('roles').updateMany({ isSystem: true }, {
      $pull: { permissions: { $in: [...TEMPLATE_PERMISSIONS] } },
    } as never);
  },
};
