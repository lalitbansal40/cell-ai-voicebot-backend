import { Types } from 'mongoose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  captureWhatsApp,
  chargeWhatsAppLate,
  credit,
  holdForCall,
  holdForWhatsApp,
  releaseHold,
  releaseWhatsApp,
} from '../../src/core/billing/engine';
import { resetWalletEventThrottle } from '../../src/core/billing/events';
import { reapStaleHolds } from '../../src/core/billing/reaper';
import { reapWhatsAppHolds } from '../../src/core/billing/whatsapp-reaper';
import { AccountModel } from '../../src/db/models/account.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel, type MessageDoc } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { onMessageStatus } from '../../src/modules/whatsapp-billing/billing-hook';
import { createTestAccount } from '../helpers/auth';
import { expectWalletConsistent } from '../helpers/billing';
import { useTestDb } from '../helpers/db';

useTestDb();

const RUPEE = 1_000_000;
const PRICE = 140_000;
const breakdown = {
  waCategory: 'utility',
  waMarket: 'IN',
  metaCostMicros: 115_000,
  markupMicros: 25_000,
  platformFeeMicros: 0,
};

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});
afterEach(() => resetWalletEventThrottle());

let n = 0;
const account = async (rupees: number, over: Record<string, unknown> = {}) => {
  n += 1;
  const a = await AccountModel.create({ name: `WA ${String(n)}`, slug: `wa-bill-${String(n)}` });
  if (rupees > 0) {
    await credit({
      accountId: a._id,
      type: 'topup',
      amountMicros: rupees * RUPEE,
      ref: { type: 'manual', id: 'seed' },
      idempotencyKey: `wa-seed-${String(n)}`,
    });
  } else {
    await credit({
      accountId: a._id,
      type: 'topup',
      amountMicros: 1,
      ref: { type: 'manual', id: 'seed' },
      idempotencyKey: `wa-seed-${String(n)}`,
    });
  }
  if (Object.keys(over).length) await WalletModel.updateOne({ accountId: a._id }, { $set: over });
  return a._id;
};
const wallet = async (accountId: Types.ObjectId) =>
  (await WalletModel.findOne({ accountId }).lean())!;
const hold = (accountId: Types.ObjectId, clientId: string, amount = PRICE) =>
  holdForWhatsApp({
    accountId,
    clientId,
    amountMicros: amount,
    breakdown,
    ref: { type: 'whatsapp_message', id: clientId },
  });

describe('WhatsApp holds and captures', () => {
  it('hold → capture: exact micros, ledger breakdown, monthly WhatsApp spend', async () => {
    const accountId = await account(10);
    const h = await hold(accountId, 'c-1');
    expect(h.entries[0]).toMatchObject({
      type: 'whatsapp_charge',
      status: 'held',
      amountMicros: PRICE,
      breakdown: { ...breakdown, kind: 'whatsapp' },
      idempotencyKey: 'wa-hold-c-1',
    });
    expect((await wallet(accountId)).holdMicros).toBe(PRICE);
    // the same clientId replays the hold
    expect((await hold(accountId, 'c-1')).replay).toBe(true);
    const msgId = new Types.ObjectId().toString();
    const cap = await captureWhatsApp({ accountId, holdId: h.entries[0]!._id, messageId: msgId });
    expect(cap.entries[0]).toMatchObject({
      status: 'captured',
      amountMicros: PRICE,
      balanceAfterMicros: 10 * RUPEE - PRICE,
      holdId: h.entries[0]!._id,
      idempotencyKey: `wa-capture-${msgId}`,
    });
    expect(await wallet(accountId)).toMatchObject({
      balanceMicros: 10 * RUPEE - PRICE,
      holdMicros: 0,
      spend: { whatsappMicros: PRICE },
    });
    expect(
      (await captureWhatsApp({ accountId, holdId: h.entries[0]!._id, messageId: msgId })).replay,
    ).toBe(true);
    await expectWalletConsistent(accountId);
  });

  it('release gives the hold back; capture after release is refused (late path instead)', async () => {
    const accountId = await account(10);
    const h = await hold(accountId, 'c-2');
    await releaseWhatsApp({ accountId, holdId: h.entries[0]!._id, reason: 'not_billable' });
    expect((await wallet(accountId)).holdMicros).toBe(0);
    expect(
      (await releaseWhatsApp({ accountId, holdId: h.entries[0]!._id, reason: 'x' })).replay,
    ).toBe(true);
    expect(await LedgerEntryModel.findById(h.entries[0]!._id).lean()).toMatchObject({
      status: 'released',
      releaseReason: 'not_billable',
    });
    await expect(
      captureWhatsApp({ accountId, holdId: h.entries[0]!._id, messageId: 'm-2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
    await expectWalletConsistent(accountId);
  });

  it('late charge: direct debit, may go below zero, once per message', async () => {
    const accountId = await account(0);
    const r = await chargeWhatsAppLate({
      accountId,
      messageId: 'm-late',
      amountMicros: PRICE,
      breakdown,
      ref: { type: 'whatsapp_message', id: 'm-late' },
    });
    expect(r.wallet.balanceMicros).toBe(1 - PRICE);
    expect(
      (
        await chargeWhatsAppLate({
          accountId,
          messageId: 'm-late',
          amountMicros: PRICE,
          breakdown,
          ref: { type: 'whatsapp_message', id: 'm-late' },
        })
      ).replay,
    ).toBe(true);
    expect((await wallet(accountId)).spend.whatsappMicros).toBe(PRICE);
    await expectWalletConsistent(accountId);
  });

  it('insufficient balance, credit limit and the WhatsApp budget', async () => {
    const poor = await account(0);
    await expect(hold(poor, 'c-poor')).rejects.toMatchObject({
      code: 'WALLET_INSUFFICIENT_BALANCE',
      details: [{ path: 'whatsapp' }],
    });
    const credit10 = await account(0, { creditLimitMicros: 10 * RUPEE });
    await hold(credit10, 'c-credit');
    const budget = await account(10, { 'budgets.monthlyWhatsappMicros': PRICE });
    const b1 = await hold(budget, 'c-b1');
    // like calls, the budget counts what was spent (captured), not what is held
    await captureWhatsApp({ accountId: budget, holdId: b1.entries[0]!._id, messageId: 'b1' });
    await expect(hold(budget, 'c-b2')).rejects.toMatchObject({
      code: 'WALLET_BUDGET_EXCEEDED',
      details: [{ path: 'whatsapp', message: 'Monthly WhatsApp budget reached' }],
    });
    for (const a of [poor, credit10, budget]) await expectWalletConsistent(a);
  });

  it('200 parallel holds on a small wallet never pass the available balance', async () => {
    const accountId = await account(1); // ₹1 → 7 holds of ₹0.14
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) => hold(accountId, `par-${String(i)}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(Math.floor((RUPEE + 1) / PRICE));
    const w = await wallet(accountId);
    expect(w.holdMicros).toBe(ok * PRICE);
    expect(w.balanceMicros - w.holdMicros).toBeGreaterThanOrEqual(0);
    await expectWalletConsistent(accountId);
  });

  it('call and WhatsApp holds stay apart (call release refuses a WhatsApp hold and vice versa)', async () => {
    const accountId = await account(100);
    const wa = await hold(accountId, 'c-apart');
    const call = await holdForCall({
      accountId,
      ref: { type: 'call', id: 'x' },
      idempotencyKey: 'call-apart',
    });
    await expect(
      releaseHold({ accountId, holdId: wa.entries[0]!._id, reason: 'x' }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(
      releaseWhatsApp({ accountId, holdId: call.entries[0]!._id, reason: 'x' }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('reapers', () => {
  it('the call reaper leaves WhatsApp holds; the WhatsApp reaper releases them after 72 h', async () => {
    const accountId = await account(10);
    const h = await hold(accountId, 'c-reap');
    const msg = await MessageModel.create({
      accountId,
      channelId: new Types.ObjectId(),
      contactId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      direction: 'out',
      origin: 'agent',
      type: 'text',
      status: 'sent',
      at: new Date(),
      billing: {
        payer: 'platform',
        market: 'IN',
        category: 'service',
        estimateMicros: PRICE,
        priceMicros: PRICE,
        holdId: h.entries[0]!._id,
        status: 'held',
        at: new Date(),
      },
    });
    await LedgerEntryModel.collection.updateOne(
      { _id: h.entries[0]!._id },
      { $set: { createdAt: new Date(Date.now() - 3 * 3_600_000) } },
    );
    await reapStaleHolds();
    expect((await LedgerEntryModel.findById(h.entries[0]!._id).lean())?.status).toBe('held');
    expect(await reapWhatsAppHolds()).toEqual({ released: 0 });
    await LedgerEntryModel.collection.updateOne(
      { _id: h.entries[0]!._id },
      { $set: { createdAt: new Date(Date.now() - 73 * 3_600_000) } },
    );
    expect(await reapWhatsAppHolds()).toEqual({ released: 1 });
    expect((await MessageModel.findById(msg._id).lean())?.billing?.status).toBe('released');
    expect((await wallet(accountId)).holdMicros).toBe(0);
    // a billable status that still arrives charges late (bell when below zero is tested below)
    expect(
      await onMessageStatus({
        accountId,
        messageId: msg._id,
        status: 'delivered',
        pricing: {
          billable: true,
          model: 'PMP',
          category: 'service',
          type: 'regular',
          subtype: null,
          conversationId: null,
          conversationOrigin: null,
        },
      }),
    ).toBe('late_charged');
    await expectWalletConsistent(accountId);
  });

  it('the WhatsApp hold age comes from the platform settings', async () => {
    await PlatformSettingsModel.updateOne(
      { key: 'whatsappBilling' },
      { $set: { value: { markupBps: 1500, platformFeeMicros: 0, holdMaxAgeHours: 1 } } },
      { upsert: true },
    );
    const accountId = await account(10);
    const h = await hold(accountId, 'c-age');
    await LedgerEntryModel.collection.updateOne(
      { _id: h.entries[0]!._id },
      { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } },
    );
    expect(await reapWhatsAppHolds()).toEqual({ released: 1 });
    await PlatformSettingsModel.deleteMany({});
  });
});

describe('billing hook (first decisive signal wins)', () => {
  const pricing = (billable: boolean | null, category = 'utility', type = 'regular') => ({
    billable,
    model: 'PMP',
    category,
    type,
    subtype: null,
    conversationId: null,
    conversationOrigin: null,
  });

  const sentMessage = async (accountId: Types.ObjectId, clientId: string, category = 'utility') => {
    const h = await hold(accountId, clientId);
    const msg = await MessageModel.create({
      accountId,
      channelId: new Types.ObjectId(),
      contactId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      direction: 'out',
      origin: 'agent',
      type: 'text',
      status: 'accepted',
      at: new Date(),
      billing: {
        payer: 'platform',
        market: 'IN',
        category,
        estimateMicros: PRICE,
        priceMicros: PRICE,
        metaCostMicros: 115_000,
        holdId: h.entries[0]!._id,
        status: 'held',
        at: new Date(),
      },
    });
    return msg;
  };
  const billingOf = async (id: Types.ObjectId) =>
    (await MessageModel.findById(id).lean<MessageDoc>())?.billing;

  it('billable → captured once; replays and out-of-order statuses change nothing', async () => {
    const accountId = await account(10);
    const msg = await sentMessage(accountId, 'h-1');
    const on = (
      status: 'sent' | 'delivered' | 'read' | 'failed',
      p: ReturnType<typeof pricing> | null,
    ) => onMessageStatus({ accountId, messageId: msg._id, status, pricing: p });
    expect(await on('sent', null)).toBe('none');
    expect(await on('delivered', pricing(true))).toBe('captured');
    expect(await on('sent', pricing(true))).toBe('none'); // `sent` never decides
    expect(await on('read', pricing(false))).toBe('ignored');
    expect(await billingOf(msg._id)).toMatchObject({
      status: 'captured',
      billable: true,
      pricingType: 'regular',
      metaCategory: 'utility',
      categoryMismatch: false,
    });
    expect(
      await LedgerEntryModel.countDocuments({
        accountId,
        type: 'whatsapp_charge',
        status: 'captured',
      }),
    ).toBe(1);
    await expectWalletConsistent(accountId);
  });

  it('regression: billable on `sent` is not a charge — a sent then failed message is released', async () => {
    // Meta charges delivered messages only; `sent` carries the expected pricing already
    const accountId = await account(10);
    const msg = await sentMessage(accountId, 'h-sent-failed');
    expect(
      await onMessageStatus({
        accountId,
        messageId: msg._id,
        status: 'sent',
        pricing: pricing(true),
      }),
    ).toBe('none');
    expect(
      await onMessageStatus({ accountId, messageId: msg._id, status: 'failed', pricing: null }),
    ).toBe('released');
    expect((await billingOf(msg._id))?.status).toBe('released');
    expect(
      await LedgerEntryModel.countDocuments({
        accountId,
        type: 'whatsapp_charge',
        status: 'captured',
      }),
    ).toBe(0);
    await expectWalletConsistent(accountId);
  });

  it('not billable / free entry point / failed → released', async () => {
    const accountId = await account(10);
    const free = await sentMessage(accountId, 'h-2');
    const entry = await sentMessage(accountId, 'h-3');
    const failed = await sentMessage(accountId, 'h-4');
    expect(
      await onMessageStatus({
        accountId,
        messageId: free._id,
        status: 'delivered',
        pricing: pricing(false, 'service', 'free_customer_service'),
      }),
    ).toBe('released');
    expect(
      await onMessageStatus({
        accountId,
        messageId: entry._id,
        status: 'sent',
        pricing: pricing(false, 'utility', 'free_entry_point'),
      }),
    ).toBe('released');
    expect(
      await onMessageStatus({ accountId, messageId: failed._id, status: 'failed', pricing: null }),
    ).toBe('released');
    expect((await billingOf(free._id))?.status).toBe('released');
    expect((await wallet(accountId)).holdMicros).toBe(0);
    await expectWalletConsistent(accountId);
  });

  it('category mismatch: captured at the held price and flagged', async () => {
    const accountId = await account(10);
    const msg = await sentMessage(accountId, 'h-5', 'utility');
    await onMessageStatus({
      accountId,
      messageId: msg._id,
      status: 'delivered',
      pricing: pricing(true, 'marketing'),
    });
    expect(await billingOf(msg._id)).toMatchObject({
      status: 'captured',
      metaCategory: 'marketing',
      categoryMismatch: true,
    });
    const row = await LedgerEntryModel.findOne({
      accountId,
      status: 'captured',
      type: 'whatsapp_charge',
    }).lean();
    expect(row).toMatchObject({ amountMicros: PRICE });
    expect(row?.note).toContain('Meta billed marketing');
  });

  it('a billable status after a failed release charges late once; below zero rings the bell', async () => {
    const acc = await createTestAccount();
    const owner = await acc.addUser('owner');
    await acc.addUser('viewer');
    const accountId = acc.account._id;
    await credit({
      accountId,
      type: 'topup',
      amountMicros: PRICE,
      ref: { type: 'manual', id: 's' },
      idempotencyKey: 'late-seed',
    });
    const msg = await sentMessage(accountId, 'h-6');
    await onMessageStatus({ accountId, messageId: msg._id, status: 'failed', pricing: null });
    // the money left meanwhile
    await chargeWhatsAppLate({
      accountId,
      messageId: 'other',
      amountMicros: PRICE,
      breakdown,
      ref: { type: 'whatsapp_message', id: 'other' },
    });
    expect(
      await onMessageStatus({
        accountId,
        messageId: msg._id,
        status: 'delivered',
        pricing: pricing(true),
      }),
    ).toBe('late_charged');
    expect(
      await onMessageStatus({
        accountId,
        messageId: msg._id,
        status: 'read',
        pricing: pricing(true),
      }),
    ).toBe('ignored');
    expect((await billingOf(msg._id))?.status).toBe('late_charged');
    const bells = await NotificationModel.find({
      accountId,
      type: 'wallet.whatsapp_late_charge',
    }).lean();
    expect(bells.map((b) => b.userId.toString())).toEqual([owner.user._id.toString()]);
    expect(bells[0]).toMatchObject({ link: '/wallet', title: 'WhatsApp message charged late' });
    await expectWalletConsistent(accountId);
  });

  it('messages without billing (before Phase 11 / notes) are left alone', async () => {
    const accountId = await account(10);
    const msg = await MessageModel.create({
      accountId,
      channelId: new Types.ObjectId(),
      contactId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      direction: 'out',
      origin: 'agent',
      type: 'text',
      status: 'sent',
      at: new Date(),
    });
    expect(
      await onMessageStatus({
        accountId,
        messageId: msg._id,
        status: 'delivered',
        pricing: pricing(true),
      }),
    ).toBe('none');
    expect(
      await onMessageStatus({
        accountId: new Types.ObjectId(),
        messageId: msg._id,
        status: 'delivered',
        pricing: pricing(true),
      }),
    ).toBe('none');
  });
});
