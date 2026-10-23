import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel, DEFAULT_TEMPLATE_SETTINGS } from '../../src/db/models/account.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppBillingDailyModel } from '../../src/db/models/whatsapp-billing-daily.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  PLACEHOLDER_MARKETS,
  rateCardProblems,
  WhatsAppRateCardModel,
  type RateCardMarket,
} from '../../src/db/models/whatsapp-rate-card.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { useTestDb } from '../helpers/db';

useTestDb();

beforeAll(async () => {
  await WhatsAppTemplateModel.createIndexes();
  await WhatsAppRateCardModel.createIndexes();
  await PlatformSettingsModel.createIndexes();
  await WhatsAppBillingDailyModel.createIndexes();
  await MessageModel.createIndexes();
});

const template = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: new Types.ObjectId(),
  wabaId: '1000000001',
  name: 'order_update',
  language: 'en',
  category: 'UTILITY',
  status: 'DRAFT',
  ...over,
});

const market = (over: Partial<RateCardMarket> = {}): RateCardMarket => ({
  ...structuredClone(PLACEHOLDER_MARKETS[0] as RateCardMarket),
  ...over,
});
const other = (): RateCardMarket => structuredClone(PLACEHOLDER_MARKETS[1] as RateCardMarket);

describe('WhatsAppTemplate model', () => {
  it('defaults, declared sub-fields and validation', async () => {
    const doc = await WhatsAppTemplateModel.create(
      template({
        components: [{ type: 'BODY', text: 'Hi {{1}}' }],
        variables: [{ key: '1', component: 'body', example: 'Asha' }],
        statusHistory: [{ status: 'DRAFT', at: new Date(), source: 'user' }],
        quality: { score: 'GREEN', at: new Date() },
        headerMedia: { storageKey: 'k', mimeType: 'image/png', size: 10 },
        statusReason: { reason: 'INVALID_FORMAT' },
        editsLog: [{ at: new Date() }],
      }),
    );
    expect(doc.toObject()).toMatchObject({
      metaTemplateId: null,
      parameterFormat: 'positional',
      purpose: 'general',
      editable: true,
      channelIds: [],
      pausedUntil: null,
      previousCategory: null,
      ttlSeconds: null,
      deletedAt: null,
      lastEventAt: null,
      usage: { sent: 0, delivered: 0, read: 0, failed: 0, lastSentAt: null },
      components: [{ type: 'BODY', text: 'Hi {{1}}' }],
      variables: [
        {
          key: '1',
          component: 'body',
          index: 0,
          example: 'Asha',
          defaultSource: { kind: 'ask', value: null },
        },
      ],
      quality: { score: 'GREEN' },
      headerMedia: { storageKey: 'k', fileName: null, handle: null, handleAt: null },
      statusReason: { reason: 'INVALID_FORMAT', title: null, description: null },
    });
    for (const bad of [
      { name: 'Order-Update' },
      { name: 'x'.repeat(513) },
      { language: 'english' },
      { category: 'SERVICE' },
      { status: 'LIVE' },
      { parameterFormat: 'mixed' },
      { purpose: 'other' },
      { accountId: undefined },
      { wabaId: undefined },
      { variables: [{ key: '1', component: 'footer' }] },
      { variables: [{ key: '1', component: 'body', defaultSource: { kind: 'random' } }] },
      {
        variables: Array.from({ length: 21 }, (_, i) => ({
          key: String(i + 1),
          component: 'body',
        })),
      },
      { quality: { score: 'BLUE', at: new Date() } },
      { statusHistory: [{ status: 'DRAFT', at: new Date(), source: 'robot' }] },
    ]) {
      await expect(WhatsAppTemplateModel.create(template(bad))).rejects.toThrow();
    }
    await WhatsAppTemplateModel.create(template({ name: 'promo', language: 'en_US' }));
    await WhatsAppTemplateModel.create(template({ name: 'promo', language: 'hi' }));
  });

  it('one live template per account × WABA × name × language; deleted rows keep history', async () => {
    const base = template({ name: 'unique_one' });
    const first = await WhatsAppTemplateModel.create(base);
    await expect(WhatsAppTemplateModel.create({ ...base })).rejects.toMatchObject({ code: 11000 });
    await WhatsAppTemplateModel.create({ ...base, language: 'hi' });
    await WhatsAppTemplateModel.create({ ...base, accountId: new Types.ObjectId() });
    await WhatsAppTemplateModel.updateOne({ _id: first._id }, { status: 'DELETED' });
    // the name is free again at our side once Meta deleted it (Meta's 30-day lock is checked in code)
    await WhatsAppTemplateModel.create({ ...base });
    await WhatsAppTemplateModel.create({ ...base, status: 'DELETED' });
  });

  it('a Meta template id is unique per WABA; drafts have none', async () => {
    const accountId = new Types.ObjectId();
    await WhatsAppTemplateModel.create(template({ accountId, name: 'a1' }));
    await WhatsAppTemplateModel.create(template({ accountId, name: 'a2' }));
    await WhatsAppTemplateModel.create(template({ accountId, name: 'a3', metaTemplateId: '77' }));
    await expect(
      WhatsAppTemplateModel.create(template({ accountId, name: 'a4', metaTemplateId: '77' })),
    ).rejects.toMatchObject({ code: 11000 });
    await WhatsAppTemplateModel.create(
      template({ accountId, name: 'a5', metaTemplateId: '77', wabaId: '1000000002' }),
    );
  });

  it('has the declared indexes and is tenant-scoped', async () => {
    const indexes = await WhatsAppTemplateModel.collection.indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        key: { accountId: 1, wabaId: 1, name: 1, language: 1 },
        unique: true,
      }),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { accountId: 1, status: 1, updatedAt: -1 } }),
    );
    expect(indexes).toContainEqual(expect.objectContaining({ key: { accountId: 1, purpose: 1 } }));
    expect(WhatsAppTemplateModel.schema.path('accountId').isRequired).toBe(true);
  });
});

describe('WhatsAppRateCard model', () => {
  it('stores the placeholder card and validates micros', async () => {
    const card = await WhatsAppRateCardModel.create({
      effectiveFrom: new Date(),
      source: 'manual',
      markets: structuredClone(PLACEHOLDER_MARKETS),
    });
    expect(card.toObject()).toMatchObject({ currency: 'INR', note: null, createdBy: null });
    expect(card.toObject()).not.toHaveProperty('accountId');
    for (const bad of [
      { marketingMicros: -1 },
      { utilityMicros: 1.5 },
      { market: 'india' },
      { callingCodes: ['+91'] },
      { callingCodes: ['12345'] },
      { authenticationInternationalMicros: -5 },
      { utilityTiers: [{ fromMessages: 0, micros: -1 }] },
    ]) {
      await expect(
        WhatsAppRateCardModel.create({
          effectiveFrom: new Date(),
          source: 'manual',
          markets: [market(bad as Partial<RateCardMarket>), other()],
        }),
      ).rejects.toThrow();
    }
    await expect(
      WhatsAppRateCardModel.create({
        effectiveFrom: new Date(),
        source: 'csv' as never,
        markets: [other()],
      }),
    ).rejects.toThrow();
  });

  it('needs exactly one OTHER market, unique markets and no shared calling code', async () => {
    expect(rateCardProblems([market(), other()])).toEqual([]);
    expect(rateCardProblems([market()])).toEqual(['Exactly one OTHER market is required']);
    expect(rateCardProblems([market(), other(), other()])).toEqual(
      expect.arrayContaining([
        'Exactly one OTHER market is required',
        'Market OTHER is listed twice',
      ]),
    );
    expect(rateCardProblems([market(), market({ market: 'IN_2' }), other()])).toEqual([
      'Calling code 91 is in IN and IN_2',
    ]);
    expect(rateCardProblems([market({ callingCodes: ['91', '91'] }), other()])).toEqual([
      'Calling code 91 is listed twice in IN',
    ]);
    // the market pattern is the schema's job; the list check only counts and compares
    const many = Array.from({ length: 300 }, (_, i) =>
      market({ market: `M${String(i)}`, callingCodes: [] }),
    );
    expect(rateCardProblems([...many, other()])).toEqual(['At most 300 markets']);
    await expect(
      WhatsAppRateCardModel.create({
        effectiveFrom: new Date(),
        source: 'meta_csv',
        markets: [market()],
      }),
    ).rejects.toThrow('Exactly one OTHER market is required');
    expect(await WhatsAppRateCardModel.collection.indexes()).toContainEqual(
      expect.objectContaining({ key: { effectiveFrom: -1 } }),
    );
  });
});

describe('PlatformSettings model', () => {
  it('one row per key with a validated value', async () => {
    await PlatformSettingsModel.create({
      key: 'whatsappBilling',
      value: { markupBps: 1500, platformFeeMicros: 0, holdMaxAgeHours: 72 },
    });
    await expect(
      PlatformSettingsModel.create({
        key: 'whatsappBilling',
        value: { markupBps: 1, platformFeeMicros: 0, holdMaxAgeHours: 72 },
      }),
    ).rejects.toMatchObject({ code: 11000 });
    for (const value of [
      { markupBps: -1, platformFeeMicros: 0, holdMaxAgeHours: 72 },
      { markupBps: 1500, platformFeeMicros: -1, holdMaxAgeHours: 72 },
      { markupBps: 1500, platformFeeMicros: 0, holdMaxAgeHours: 0 },
      { markupBps: 1500, platformFeeMicros: 0 },
    ]) {
      await expect(
        PlatformSettingsModel.validate({ key: 'whatsappBilling', value }),
      ).rejects.toThrow();
    }
    await expect(
      PlatformSettingsModel.validate({
        key: 'other',
        value: { markupBps: 1, platformFeeMicros: 0, holdMaxAgeHours: 1 },
      }),
    ).rejects.toThrow();
  });
});

describe('WhatsAppBillingDaily model', () => {
  it('one row per WABA × day × category', async () => {
    const row = {
      accountId: new Types.ObjectId(),
      wabaId: '1000000001',
      day: '2026-10-22',
      category: 'marketing' as const,
      metaVolume: 10,
      metaCostMicros: 8_631_000,
      ourCaptured: 9,
      ourBilledMicros: 8_933_100,
      diffVolume: -1,
      diffMicros: 302_100,
      fetchedAt: new Date(),
    };
    await WhatsAppBillingDailyModel.create(row);
    await expect(WhatsAppBillingDailyModel.create({ ...row })).rejects.toMatchObject({
      code: 11000,
    });
    await WhatsAppBillingDailyModel.create({ ...row, category: 'utility' });
    for (const bad of [{ day: '22-10-2026' }, { category: 'promo' as never }, { metaVolume: -1 }]) {
      await expect(WhatsAppBillingDailyModel.create({ ...row, ...bad })).rejects.toThrow();
    }
  });
});

describe('Phase 11 additions on existing models', () => {
  it('message template + billing keep their declared fields; held index exists', async () => {
    const templateId = new Types.ObjectId();
    const holdId = new Types.ObjectId();
    const msg = await MessageModel.create({
      accountId: new Types.ObjectId(),
      channelId: new Types.ObjectId(),
      contactId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      direction: 'out',
      origin: 'api',
      type: 'template',
      text: 'Hi Asha, your order shipped',
      status: 'queued',
      at: new Date(),
      template: {
        templateId,
        name: 'order_update',
        language: 'en',
        category: 'UTILITY',
        parameters: [{ key: '1', value: 'Asha' }],
      },
      billing: {
        payer: 'platform',
        market: 'IN',
        category: 'utility',
        estimateMicros: 132_300,
        priceMicros: 132_300,
        holdId,
        status: 'held',
        at: new Date(),
      },
      pricing: { billable: true, category: 'utility', type: 'regular', subtype: 'paid_exempt' },
    });
    const saved = (await MessageModel.findById(msg._id).lean())!;
    expect(saved.template).toMatchObject({ templateId, parameters: [{ key: '1', value: 'Asha' }] });
    expect(saved.billing).toMatchObject({
      payer: 'platform',
      holdId,
      status: 'held',
      metaCostMicros: 0,
      billable: null,
      pricingType: null,
      metaCategory: null,
      categoryMismatch: false,
    });
    expect(saved.pricing?.subtype).toBe('paid_exempt');
    await expect(
      MessageModel.validate({
        ...saved,
        _id: undefined,
        billing: { ...saved.billing, status: 'paid' },
      }),
    ).rejects.toThrow();
    const indexes = await MessageModel.collection.indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: 'billing_held_at',
        partialFilterExpression: { 'billing.status': 'held' },
      }),
    );
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'template_contact_at' }));
  });

  it('contact marketing, wallet budget, ledger breakdown, account and channel fields', async () => {
    expect(ContactModel.schema.path('whatsapp.marketing')).toBeDefined();
    const contact = new ContactModel({
      accountId: new Types.ObjectId(),
      whatsapp: { marketing: { stopped: true, at: new Date(), source: 'error_131050' } },
    });
    expect(contact.whatsapp?.marketing).toMatchObject({ stopped: true, source: 'error_131050' });
    await expect(
      new ContactModel({
        accountId: new Types.ObjectId(),
        whatsapp: { marketing: { stopped: true, source: 'sms' } },
      }).validate(['whatsapp.marketing.source']),
    ).rejects.toThrow('whatsapp.marketing.source');

    const wallet = new WalletModel({ accountId: new Types.ObjectId() });
    expect(wallet.budgets.monthlyWhatsappMicros).toBe(0);
    expect(wallet.spend.whatsappMicros).toBe(0);

    for (const field of [
      'waCategory',
      'waMarket',
      'metaCostMicros',
      'markupMicros',
      'platformFeeMicros',
      'waPricingType',
    ]) {
      expect(LedgerEntryModel.schema.path(`breakdown.${field}`)).toBeDefined();
    }

    const account = new AccountModel({ name: 'A', slug: 'p11-model-a' });
    expect(account.settings.templates).toEqual(DEFAULT_TEMPLATE_SETTINGS);
    expect(account.whatsappBilling).toBeNull();
    const priced = new AccountModel({
      name: 'B',
      slug: 'p11-model-b',
      whatsappBilling: { markupBps: 2000, fixedPrices: { marketing: 900_000 } },
    });
    expect(priced.whatsappBilling).toMatchObject({
      markupBps: 2000,
      fixedPrices: { marketing: 900_000 },
      platformFeeMicros: null,
    });
    await expect(
      new AccountModel({
        name: 'C',
        slug: 'p11-model-c',
        whatsappBilling: { markupBps: -1 },
      }).validate(['whatsappBilling']),
    ).rejects.toThrow('markupBps');

    const channel = new WhatsAppChannelModel({
      pricingTier: [{ category: 'utility', market: 'IN', tier: '1001:10000', at: new Date() }],
    });
    expect(channel.pricingTier?.[0]).toMatchObject({ category: 'utility', tier: '1001:10000' });
    expect(new WhatsAppChannelModel({}).pricingTier).toEqual([]);
  });
});
