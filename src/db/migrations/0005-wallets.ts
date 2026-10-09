import type { Db } from 'mongodb';

import type { Migration } from '../migrate';
import { DEFAULT_RATE_CARD } from '../models/rate-card.model';
import { DEFAULT_LOW_BALANCE_THRESHOLD_MICROS } from '../models/wallet.model';

const NEW_COLLECTIONS = ['invoiceCounters', 'paymentEvents', 'notifications'] as const;

const ensureCollection = async (db: Db, name: string) => {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(name);
};

/**
 * Phase 4: a wallet for every customer account (balance 0, ₹500 alert
 * threshold), the platform default rate card and the new collections.
 */
export const walletsMigration: Migration = {
  name: '0005-wallets',
  up: async (db) => {
    const now = new Date();
    const accounts = db
      .collection('accounts')
      .find({ isPlatform: { $ne: true } }, { projection: { _id: 1 } });
    for await (const account of accounts) {
      await db.collection('wallets').updateOne(
        { accountId: account._id },
        {
          $setOnInsert: {
            accountId: account._id,
            currency: 'INR',
            balanceMicros: 0,
            holdMicros: 0,
            creditLimitMicros: 0,
            lowBalanceThresholdMicros: DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
            budgets: { monthlyCallMicros: 0, monthlyAiMicros: 0 },
            spend: { month: null, callMicros: 0, aiMicros: 0, ttsMicros: 0 },
            alerts: { lowBalanceNotifiedAt: null, exhaustedNotifiedAt: null },
            version: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }
    const hasDefault = await db.collection('rateCards').countDocuments({ accountId: null });
    if (!hasDefault) {
      await db.collection('rateCards').insertOne({
        accountId: null,
        ...DEFAULT_RATE_CARD,
        inheritsDefault: false,
        effectiveFrom: new Date(0),
        createdBy: null,
        note: 'Platform default (migration 0005) — placeholder until rates are final',
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const name of NEW_COLLECTIONS) await ensureCollection(db, name);
  },
  down: async (db) => {
    const ledgerRows = await db.collection('ledgerEntries').countDocuments({}, { limit: 1 });
    if (ledgerRows > 0) {
      throw new Error('0005-wallets: refusing to roll back — the ledger has money movements');
    }
    await db.collection('wallets').deleteMany({});
    await db.collection('rateCards').deleteMany({});
    for (const name of NEW_COLLECTIONS) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) await db.dropCollection(name);
    }
  },
};
