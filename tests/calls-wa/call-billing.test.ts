import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  credit,
  extendWhatsAppCallHold,
  holdForWhatsAppCall,
  loadWhatsAppCallHold,
  releaseWhatsAppCallHold,
  settleWhatsAppCall,
} from '../../src/core/billing/engine';
import {
  callHoldMicros,
  callPrice,
  perPulseMicros,
  pulsesFor,
} from '../../src/core/billing/whatsapp-calls';
import { AccountModel } from '../../src/db/models/account.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppRateCardModel } from '../../src/db/models/whatsapp-rate-card.model';
import { quoteCall } from '../../src/modules/whatsapp-calling/billing';
import { createTestAccount } from '../helpers/auth';
import { expectWalletConsistent } from '../helpers/billing';
import { useTestDb } from '../helpers/db';

useTestDb();

const IN = {
  perMinuteMicros: 388_500,
  markupBps: 1500,
  fixedPerMinuteMicros: null,
  platformFeePerMinuteMicros: 0,
  payer: 'platform' as const,
};

describe('WhatsApp call pulse math (exact)', () => {
  it('pulses = ceil(seconds / 6); per pulse = per minute ÷ 10 rounded up', () => {
    expect([0, 1, 6, 7, 56, 3_600].map(pulsesFor)).toEqual([0, 1, 1, 2, 10, 600]);
    expect(pulsesFor(-3)).toBe(0);
    expect(perPulseMicros(388_500)).toBe(38_850);
    expect(perPulseMicros(388_501)).toBe(38_851);
    expect(perPulseMicros(-1)).toBe(0);
  });

  it('selling total = paise-rounded (Meta × (1 + markup)) + paise-rounded fee', () => {
    const cases: [number, number, number][] = [
      // seconds, Meta cost, selling total
      [0, 0, 0],
      [1, 38_850, 50_000],
      [6, 38_850, 50_000],
      [7, 77_700, 90_000],
      [56, 388_500, 450_000],
      [3_600, 23_310_000, 26_810_000],
    ];
    for (const [sec, meta, total] of cases) {
      const p = callPrice(IN, sec);
      expect({ sec, meta: p.metaCostMicros, total: p.totalMicros }).toEqual({ sec, meta, total });
      expect(p.markupMicros).toBe(p.totalMicros - p.platformFeeMicros - p.metaCostMicros);
    }
    // fixed per-minute price wins over the markup; the fee is added per pulse
    expect(callPrice({ ...IN, fixedPerMinuteMicros: 500_000 }, 7)).toMatchObject({
      pulses: 2,
      totalMicros: 100_000,
      metaCostMicros: 77_700,
    });
    expect(callPrice({ ...IN, platformFeePerMinuteMicros: 100_000 }, 7)).toMatchObject({
      platformFeeMicros: 20_000,
      totalMicros: 110_000,
    });
    // customer pays Meta: fee only
    expect(
      callPrice({ ...IN, payer: 'customer', platformFeePerMinuteMicros: 100_000 }, 56),
    ).toEqual({
      pulses: 10,
      metaPerPulseMicros: 38_850,
      metaCostMicros: 0,
      markupMicros: 0,
      platformFeeMicros: 100_000,
      totalMicros: 100_000,
    });
    expect(callPrice({ ...IN, payer: 'customer' }, 56).totalMicros).toBe(0);
    // the hold: 5 minutes of call
    expect(callHoldMicros(IN, 5)).toBe(2_240_000);
  });
});

describe('call quote', () => {
  it('uses the calling card in force, the platform settings and the account override', async () => {
    const t = await createTestAccount();
    // before migration 0013's card: the placeholder rates
    const base = await quoteCall({
      accountId: t.account._id,
      phoneE164: '+919000000001',
      payer: 'platform',
    });
    expect(base).toMatchObject({
      market: 'IN',
      perMinuteMicros: 388_500,
      markupBps: 1500,
      holdMinutes: 5,
    });
    expect(
      (await quoteCall({ accountId: t.account._id, phoneE164: '+14155550100', payer: 'platform' }))
        .market,
    ).toBe('OTHER');
    await WhatsAppRateCardModel.create({
      kind: 'calling',
      effectiveFrom: new Date(Date.now() - 1_000),
      source: 'manual',
      callingMarkets: [
        { market: 'IN', label: 'India', callingCodes: ['91'], perMinuteMicros: 400_000, tiers: [] },
        { market: 'OTHER', label: 'Other', callingCodes: [], perMinuteMicros: 900_000, tiers: [] },
      ],
    });
    // a future card is not in force yet
    await WhatsAppRateCardModel.create({
      kind: 'calling',
      effectiveFrom: new Date(Date.now() + 86_400_000),
      source: 'manual',
      callingMarkets: [
        { market: 'OTHER', label: 'Other', callingCodes: [], perMinuteMicros: 1, tiers: [] },
      ],
    });
    await PlatformSettingsModel.create({
      key: 'whatsappCalling',
      value: {
        markupBps: 2000,
        platformFeePerMinuteMicros: 10_000,
        holdMinutes: 3,
        holdExtendMinutes: 2,
      },
    });
    await AccountModel.updateOne(
      { _id: t.account._id },
      {
        $set: {
          whatsappCallingBilling: {
            markupBps: null,
            fixedPerMinuteMicros: 600_000,
            platformFeePerMinuteMicros: null,
          },
        },
      },
    );
    expect(
      await quoteCall({ accountId: t.account._id, phoneE164: '+919000000001', payer: 'customer' }),
    ).toMatchObject({
      market: 'IN',
      perMinuteMicros: 400_000,
      markupBps: 2000,
      fixedPerMinuteMicros: 600_000,
      platformFeePerMinuteMicros: 10_000,
      payer: 'customer',
      holdMinutes: 3,
      holdExtendMinutes: 2,
    });
  });
});

describe('WhatsApp call money in the engine', () => {
  const setup = async (balance = 10_000_000) => {
    const t = await createTestAccount();
    if (balance) {
      await credit({
        accountId: t.account._id,
        type: 'topup',
        amountMicros: balance,
        ref: { type: 'manual', id: 'call-billing' },
        idempotencyKey: `cb-${t.account._id.toString()}`,
      });
    }
    return t.account._id;
  };
  const wallet = (accountId: Types.ObjectId) => WalletModel.findOne({ accountId }).lean();

  it('hold → extend → settle (once, may overrun) and the wallet stays consistent', async () => {
    const accountId = await setup();
    const callId = new Types.ObjectId().toString();
    const hold = await holdForWhatsAppCall({
      accountId,
      callId,
      amountMicros: 2_240_000,
      breakdown: { waMarket: 'IN', waPerMinuteMicros: 388_500 },
    });
    const holdId = hold.entries[0]!._id;
    expect(hold.entries[0]).toMatchObject({
      type: 'whatsapp_call_charge',
      status: 'held',
      ref: { type: 'call', id: callId },
    });
    // same key → same hold
    expect(
      (await holdForWhatsAppCall({ accountId, callId, amountMicros: 1, breakdown: {} })).replay,
    ).toBe(true);
    const ext = await extendWhatsAppCallHold({
      accountId,
      holdId,
      callId,
      n: 1,
      amountMicros: 2_240_000,
    });
    expect(ext.ok).toBe(true);
    expect((await wallet(accountId))?.holdMicros).toBe(4_480_000);
    // a charge above the holds (Meta's longer duration) is taken in full
    const settled = await settleWhatsAppCall({
      accountId,
      holdId,
      callId,
      amountMicros: 5_000_000,
      breakdown: { waMarket: 'IN', waPulses: 100 },
    });
    expect(settled.entries[0]).toMatchObject({ status: 'captured', amountMicros: 5_000_000 });
    expect(settled.entries[0]?.breakdown).toMatchObject({ kind: 'whatsapp_call', waPulses: 100 });
    expect(
      (await settleWhatsAppCall({ accountId, holdId, callId, amountMicros: 1, breakdown: {} }))
        .replay,
    ).toBe(true);
    const w = await wallet(accountId);
    expect(w).toMatchObject({ holdMicros: 0, balanceMicros: 5_000_000 });
    expect(w?.spend.callMicros).toBe(5_000_000);
    await expectWalletConsistent(accountId);
    // settled holds can't be extended / released into money
    await expect(
      extendWhatsAppCallHold({ accountId, holdId, callId, n: 2, amountMicros: 1 }),
    ).rejects.toBeTruthy();
    expect((await releaseWhatsAppCallHold({ accountId, holdId, reason: 'late' })).entries).toEqual(
      [],
    );
  });

  it('an empty wallet / call budget refuses the hold; an extension says no instead of throwing', async () => {
    const poor = await setup(0);
    await expect(
      holdForWhatsAppCall({
        accountId: poor,
        callId: new Types.ObjectId().toString(),
        amountMicros: 100,
        breakdown: {},
      }),
    ).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    const capped = await setup();
    await WalletModel.updateOne(
      { accountId: capped },
      { $set: { 'budgets.monthlyCallMicros': 1_000_000 } },
    );
    await expect(
      holdForWhatsAppCall({
        accountId: capped,
        callId: new Types.ObjectId().toString(),
        amountMicros: 2_000_000,
        breakdown: {},
      }),
    ).rejects.toMatchObject({ code: 'WALLET_BUDGET_EXCEEDED' });
    const tight = await setup(3_000_000);
    const callId = new Types.ObjectId().toString();
    const hold = await holdForWhatsAppCall({
      accountId: tight,
      callId,
      amountMicros: 2_240_000,
      breakdown: {},
    });
    const no = await extendWhatsAppCallHold({
      accountId: tight,
      holdId: hold.entries[0]!._id,
      callId,
      n: 1,
      amountMicros: 2_240_000,
    });
    expect(no).toMatchObject({ ok: false, reason: 'insufficient' });
    await expect(
      holdForWhatsAppCall({
        accountId: tight,
        callId: new Types.ObjectId().toString(),
        amountMicros: 0,
        breakdown: {},
      }),
    ).rejects.toThrow(RangeError);
  });

  it('release gives every held row back once; other ledger types are never a call hold', async () => {
    const accountId = await setup();
    const callId = new Types.ObjectId().toString();
    const hold = await holdForWhatsAppCall({
      accountId,
      callId,
      amountMicros: 2_000_000,
      breakdown: {},
    });
    const holdId = hold.entries[0]!._id;
    await extendWhatsAppCallHold({ accountId, holdId, callId, n: 1, amountMicros: 1_000_000 });
    await releaseWhatsAppCallHold({ accountId, holdId, reason: 'not_answered' });
    await releaseWhatsAppCallHold({ accountId, holdId, reason: 'not_answered' });
    expect((await wallet(accountId))?.holdMicros).toBe(0);
    expect(await LedgerEntryModel.countDocuments({ accountId, status: 'held' })).toBe(0);
    await expect(
      settleWhatsAppCall({ accountId, holdId, callId, amountMicros: 1, breakdown: {} }),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
    // a zero charge settles with no charge row
    const free = new Types.ObjectId().toString();
    const h2 = await holdForWhatsAppCall({
      accountId,
      callId: free,
      amountMicros: 500_000,
      breakdown: {},
    });
    const zero = await settleWhatsAppCall({
      accountId,
      holdId: h2.entries[0]!._id,
      callId: free,
      amountMicros: 0,
      breakdown: {},
    });
    expect(zero.entries).toEqual([]);
    await expect(
      settleWhatsAppCall({
        accountId,
        holdId: h2.entries[0]!._id,
        callId: free,
        amountMicros: -1,
        breakdown: {},
      }),
    ).rejects.toThrow(RangeError);
    const topup = await LedgerEntryModel.findOne({ accountId, type: 'topup' }).lean();
    await expect(loadWhatsAppCallHold(accountId, topup!._id)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expectWalletConsistent(accountId);
  });
});
