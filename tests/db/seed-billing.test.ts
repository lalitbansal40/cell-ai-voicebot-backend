import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { DEMO_BILLING_PROFILE, seedBilling } from '../../scripts/seed-billing';
import { callCharge } from '../../src/core/billing/pricing';
import { reconcileWallets } from '../../src/core/billing/reconcile';
import { AccountModel } from '../../src/db/models/account.model';
import { InvoiceModel } from '../../src/db/models/invoice.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { isValidGstin } from '../../src/shared/gstin';
import { recordingBillingJobs } from '../helpers/billing';
import { useTestDb } from '../helpers/db';

useTestDb();
const RUPEE = 1_000_000;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});

describe('seedBilling', () => {
  it('seeds profile, credit, calls and a paid top-up once, then adds nothing', async () => {
    const account = await AccountModel.create({ name: 'Demo Finance', slug: `demo-${Date.now()}` });
    const deps = {
      ownerId: new Types.ObjectId(),
      adminId: new Types.ObjectId(),
      jobs: recordingBillingJobs().jobs,
    };
    const rec = recordingBillingJobs();
    const first = await seedBilling(account._id, { ...deps, jobs: rec.jobs });
    expect(first).toMatchObject({ profile: true, openingCredit: true, calls: 3, topup: true });
    expect(first.invoiceNumber).toMatch(/^CAV\/\d{2}-\d{2}\/\d{6}$/);
    expect(rec.queued.map((q) => q.name)).toEqual(['invoice.render']);
    expect(isValidGstin(DEMO_BILLING_PROFILE.gstin ?? '', '08')).toBe(true);

    const stored = await AccountModel.findById(account._id).lean();
    expect(stored?.billing).toMatchObject({
      legalName: DEMO_BILLING_PROFILE.legalName,
      stateCode: '08',
    });

    const charge = callCharge(DEFAULT_RATE_CARD, {
      answered: true,
      durationSec: 90,
      aiSeconds: 85,
      ttsChars: 900,
    }).totalMicros;
    const wallet = await WalletModel.findOne({ accountId: account._id }).lean();
    expect(wallet?.balanceMicros).toBe(1000 * RUPEE + 500 * RUPEE - charge);
    expect(wallet?.holdMicros).toBeGreaterThan(0); // the "held" call
    const refs = await LedgerEntryModel.distinct('ref.type', { accountId: account._id });
    expect(refs.sort()).toEqual(['seed', 'simulator', 'topup']);
    const statuses = await LedgerEntryModel.distinct('status', {
      accountId: account._id,
      'ref.type': 'simulator',
    });
    expect(statuses.sort()).toEqual(['captured', 'held', 'released']);

    const rows = await LedgerEntryModel.countDocuments({ accountId: account._id });
    const again = await seedBilling(account._id, deps);
    expect(again).toEqual({
      profile: false,
      openingCredit: false,
      calls: 0,
      topup: false,
      invoiceNumber: first.invoiceNumber,
    });
    expect(await LedgerEntryModel.countDocuments({ accountId: account._id })).toBe(rows);
    expect(await InvoiceModel.countDocuments({ accountId: account._id })).toBe(1);
    expect((await reconcileWallets()).mismatches).toEqual([]);
  });
});
