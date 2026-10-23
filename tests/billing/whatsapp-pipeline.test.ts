import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { credit, holdForWhatsApp } from '../../src/core/billing/engine';
import { buildTemplatePayload } from '../../src/core/meta';
import { AccountModel } from '../../src/db/models/account.model';
import { MessageModel, type MessageDoc } from '../../src/db/models/message.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WhatsAppBillingDailyModel } from '../../src/db/models/whatsapp-billing-daily.model';
import {
  WhatsAppRateCardModel,
  PLACEHOLDER_MARKETS,
} from '../../src/db/models/whatsapp-rate-card.model';
import { createWhatsAppBillingHook } from '../../src/modules/whatsapp-billing/billing-hook';
import {
  effectiveWhatsAppRateCard,
  invalidateWhatsAppPricingCache,
  priceMessage,
} from '../../src/modules/whatsapp-billing/pricing.service';
import { runWhatsAppReconcile } from '../../src/modules/whatsapp-billing/reconcile';
import { expectWalletConsistent } from '../helpers/billing';
import { useTestDb } from '../helpers/db';
import { useInboxWorld, valueOf } from '../helpers/inbox';

useTestDb();
const world = useInboxWorld();
const { state } = world;
const PRICE = 140_000;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});

/** An outgoing message with a WhatsApp hold, as the T11.5 send pipeline will create it. */
const heldMessage = async (to: string) => {
  const accountId = state.acc.account._id;
  const clientId = new Types.ObjectId().toString();
  const h = await holdForWhatsApp({
    accountId,
    clientId,
    amountMicros: PRICE,
    breakdown: { waCategory: 'utility', waMarket: 'IN' },
    ref: { type: 'whatsapp_message', id: clientId },
  });
  const wamid = `wamid.PIPE${new Types.ObjectId().toString()}`;
  const msg = await MessageModel.create({
    accountId,
    channelId: state.channel._id,
    contactId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    direction: 'out',
    origin: 'agent',
    type: 'template',
    status: 'accepted',
    waMessageId: wamid,
    clientId,
    at: new Date(),
    billing: {
      payer: 'platform',
      market: 'IN',
      category: 'utility',
      estimateMicros: PRICE,
      priceMicros: PRICE,
      metaCostMicros: 115_000,
      holdId: h.entries[0]!._id,
      status: 'held',
      at: new Date(),
    },
  });
  return { msg, wamid, to };
};

const status = (wamid: string, value: string, pricing: Record<string, unknown> | null) =>
  world.fixture('statuses-sent.json', (p) => {
    const s = (valueOf(p).statuses as Record<string, unknown>[])[0]!;
    Object.assign(s, {
      id: wamid,
      status: value,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    if (pricing) s.pricing = pricing;
    else delete s.pricing;
  });

const billingOf = async (id: Types.ObjectId) =>
  (await MessageModel.findById(id).lean<MessageDoc>())?.billing;

describe('statuses → billing (inbox pipeline with the billing hook)', () => {
  it('captures on the first billable status, also when that status loses the race', async () => {
    await world.setup();
    state.ix.billing = createWhatsAppBillingHook();
    const accountId = state.acc.account._id;
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 10_000_000,
      ref: { type: 'manual', id: 's' },
      idempotencyKey: `pipe-${accountId.toString()}`,
    });
    const a = await heldMessage('919000081001');
    await status(a.wamid, 'read', {
      billable: true,
      pricing_model: 'PMP',
      category: 'utility',
      type: 'regular',
    });
    // a late "sent" duplicate with pricing is ignored for the status but billing stays once
    await status(a.wamid, 'sent', {
      billable: true,
      pricing_model: 'PMP',
      category: 'utility',
      type: 'regular',
    });
    expect(await billingOf(a.msg._id)).toMatchObject({ status: 'captured', billable: true });
    const b = await heldMessage('919000081002');
    await status(b.wamid, 'delivered', {
      billable: false,
      pricing_model: 'PMP',
      category: 'service',
      type: 'free_customer_service',
    });
    expect((await billingOf(b.msg._id))?.status).toBe('released');
    const c = await heldMessage('919000081003');
    await world.fixture('statuses-failed.json', (p) => {
      const s = (valueOf(p).statuses as Record<string, unknown>[])[0]!;
      s.id = c.wamid;
    });
    expect((await billingOf(c.msg._id))?.status).toBe('released');
    await expectWalletConsistent(accountId);
    // without the hook (older workers / scripts) nothing is billed
    state.ix.billing = undefined;
    const d = await heldMessage('919000081004');
    await status(d.wamid, 'delivered', {
      billable: true,
      pricing_model: 'PMP',
      category: 'utility',
      type: 'regular',
    });
    expect((await billingOf(d.msg._id))?.status).toBe('held');
  });
});

describe('pricing service', () => {
  it('placeholder card before migration, then the newest card in force; account override; customer payer', async () => {
    invalidateWhatsAppPricingCache();
    await WhatsAppRateCardModel.deleteMany({});
    expect((await effectiveWhatsAppRateCard()).id).toBeNull();
    const accountId = (
      await AccountModel.create({ name: 'Price Co', slug: `price-${String(Date.now())}` })
    )._id;
    const quote = (over: Partial<Parameters<typeof priceMessage>[0]> = {}) =>
      priceMessage({
        accountId,
        payer: 'platform',
        phoneE164: '+919000000101',
        category: 'marketing',
        ...over,
      });
    expect(await quote()).toMatchObject({
      market: 'IN',
      priceMicros: 1_000_000,
      metaCostMicros: 863_100,
      markupBps: 1500,
    });
    const card = await WhatsAppRateCardModel.create({
      effectiveFrom: new Date(Date.now() - 1000),
      source: 'manual',
      markets: PLACEHOLDER_MARKETS.map((m) => ({ ...m, marketingMicros: 1_000_000 })),
    });
    await WhatsAppRateCardModel.create({
      effectiveFrom: new Date(Date.now() + 86_400_000),
      source: 'manual',
      markets: PLACEHOLDER_MARKETS.map((m) => ({ ...m, marketingMicros: 5_000_000 })),
    });
    // cached for 60 s → invalidate on save
    expect((await quote()).priceMicros).toBe(1_000_000);
    invalidateWhatsAppPricingCache();
    const now = await quote();
    expect(now).toMatchObject({ priceMicros: 1_150_000, rateCardId: card._id.toString() });
    // a past send time prices with the card of that time
    expect((await quote({ at: new Date(Date.now() + 2 * 86_400_000) })).priceMicros).toBe(
      5_750_000,
    );
    await PlatformSettingsModel.updateOne(
      { key: 'whatsappBilling' },
      { $set: { value: { markupBps: 2000, platformFeeMicros: 10_000, holdMaxAgeHours: 72 } } },
      { upsert: true },
    );
    invalidateWhatsAppPricingCache();
    expect((await quote()).priceMicros).toBe(1_200_000 + 10_000);
    await AccountModel.updateOne(
      { _id: accountId },
      {
        $set: {
          whatsappBilling: {
            markupBps: 0,
            fixedPrices: { utility: 300_000 },
            platformFeeMicros: 0,
          },
        },
      },
    );
    expect((await quote()).priceMicros).toBe(1_000_000);
    expect((await quote({ category: 'utility' })).priceMicros).toBe(300_000);
    expect((await quote({ phoneE164: '+447700900000', category: 'service' })).market).toBe('OTHER');
    expect((await quote({ payer: 'customer' })).priceMicros).toBe(0);
    await PlatformSettingsModel.deleteMany({});
    invalidateWhatsAppPricingCache();
  });
});

describe('reconciliation', () => {
  it('Meta analytics vs our captured charges per day × category', async () => {
    await world.setup();
    state.ix.billing = createWhatsAppBillingHook();
    const accountId = state.acc.account._id;
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 10_000_000,
      ref: { type: 'manual', id: 's' },
      idempotencyKey: `rec-${accountId.toString()}`,
    });
    const yesterday = new Date(Date.now() - 86_400_000);
    // Meta side: two billable template sends recorded by the fake yesterday
    await world.w.fake.createTemplate(state.token, state.channel.wabaId, {
      name: 'rec_instant',
      language: 'en',
      category: 'UTILITY',
      parameterFormat: 'positional',
      components: [{ type: 'BODY', text: 'Hi {{1}} ok', example: { body_text: [['A']] } }],
    });
    for (const to of ['919000082001', '919000082002']) {
      await world.w.fake.sendMessage(
        state.token,
        state.channel.phoneNumberId ?? '',
        buildTemplatePayload(to, {
          name: 'rec_instant',
          language: 'en',
          parameterFormat: 'positional',
          body: [{ key: '1', text: 'A' }],
        }),
      );
    }
    // our side: one captured message yesterday
    const a = await heldMessage('919000082001');
    await status(a.wamid, 'delivered', {
      billable: true,
      pricing_model: 'PMP',
      category: 'utility',
      type: 'regular',
    });
    await MessageModel.updateOne({ _id: a.msg._id }, { $set: { 'billing.at': yesterday } });
    const res = await runWhatsAppReconcile(world.w.ctx, new Date(Date.now() + 86_400_000));
    expect(res.failed).toBe(0);
    const row = await WhatsAppBillingDailyModel.findOne({
      wabaId: state.channel.wabaId,
      category: 'utility',
      day: new Date().toISOString().slice(0, 10),
    }).lean();
    expect(row).toMatchObject({ metaVolume: 2, metaCostMicros: 230_000 });
    const ours = await WhatsAppBillingDailyModel.findOne({
      wabaId: state.channel.wabaId,
      category: 'utility',
      day: yesterday.toISOString().slice(0, 10),
    }).lean();
    expect(ours).toMatchObject({ ourCaptured: 1, ourBilledMicros: PRICE, diffVolume: 1 });
    // a Meta failure is counted, not thrown
    world.w.fake.failNext('getPricingAnalytics');
    expect((await runWhatsAppReconcile(world.w.ctx)).failed).toBeGreaterThan(0);
  });
});
