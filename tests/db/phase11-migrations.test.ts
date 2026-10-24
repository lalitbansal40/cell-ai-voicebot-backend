import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { TEMPLATE_BILLING_COLLECTIONS } from '../../src/db/migrations/0012-templates-billing';
import { DEFAULT_TEMPLATE_SETTINGS } from '../../src/db/models/account.model';
import {
  PLACEHOLDER_MARKETS,
  PLACEHOLDER_RATE_CARD_NOTE,
} from '../../src/db/models/whatsapp-rate-card.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0012-templates-billing');
  if (!found) throw new Error('0012 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('0012-templates-billing', () => {
  it('is registered right after 0011', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0012-templates-billing')).toBe(names.indexOf('0011-inbox') + 1);
    // later migrations follow (Phase 12: tests/db/phase12-migrations.test.ts)
  });

  it('creates collections, indexes, settings, the placeholder card, backfills; idempotent', async () => {
    for (const name of TEMPLATE_BILLING_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    const accounts = db().collection('accounts');
    const old = await accounts.insertOne({ name: 'Old', slug: 'p11-mig-old', settings: {} });
    const custom = await accounts.insertOne({
      name: 'Custom',
      slug: 'p11-mig-custom',
      settings: { templates: { defaultLanguage: 'hi' } },
    });
    const wallet = await db()
      .collection('wallets')
      .insertOne({
        accountId: old.insertedId,
        budgets: { monthlyCallMicros: 5, monthlyAiMicros: 0 },
        spend: { month: '2026-10', callMicros: 1, aiMicros: 0 },
      });
    const role = await db()
      .collection('roles')
      .insertOne({
        accountId: old.insertedId,
        key: 'agent',
        name: 'Agent',
        isSystem: true,
        permissions: ['contacts.read'],
      });

    await migration().up(db());
    await migration().up(db());

    expect(await collections()).toEqual(expect.arrayContaining([...TEMPLATE_BILLING_COLLECTIONS]));
    expect(await db().collection('whatsappTemplates').indexes()).toContainEqual(
      expect.objectContaining({
        key: { accountId: 1, wabaId: 1, name: 1, language: 1 },
        unique: true,
      }),
    );
    expect(await db().collection('platformSettings').indexes()).toContainEqual(
      expect.objectContaining({ key: { key: 1 }, unique: true }),
    );
    expect(await db().collection('whatsappBillingDaily').indexes()).toContainEqual(
      expect.objectContaining({ key: { wabaId: 1, day: 1, category: 1 }, unique: true }),
    );
    expect(await db().collection('messages').indexes()).toContainEqual(
      expect.objectContaining({ name: 'billing_held_at' }),
    );

    const settings = await db().collection('platformSettings').find().toArray();
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      key: 'whatsappBilling',
      value: { markupBps: 1500, platformFeeMicros: 0, holdMaxAgeHours: 72 },
    });
    const cards = await db().collection('whatsappRateCards').find().toArray();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      currency: 'INR',
      source: 'manual',
      note: PLACEHOLDER_RATE_CARD_NOTE,
      markets: PLACEHOLDER_MARKETS,
    });

    expect((await accounts.findOne({ _id: old.insertedId }))?.settings.templates).toEqual(
      DEFAULT_TEMPLATE_SETTINGS,
    );
    expect((await accounts.findOne({ _id: custom.insertedId }))?.settings.templates).toEqual({
      defaultLanguage: 'hi',
    });
    expect(await db().collection('wallets').findOne({ _id: wallet.insertedId })).toMatchObject({
      budgets: { monthlyCallMicros: 5, monthlyWhatsappMicros: 0 },
      spend: { callMicros: 1, whatsappMicros: 0 },
    });
    const permissions = (await db().collection('roles').findOne({ _id: role.insertedId }))
      ?.permissions as string[];
    expect(permissions).toContain('templates.read');
    expect(permissions).not.toContain('templates.manage');

    await accounts.deleteMany({ _id: { $in: [old.insertedId, custom.insertedId] } });
    await db().collection('wallets').deleteOne({ _id: wallet.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });
  });

  it('keeps an existing rate card and settings row', async () => {
    await migration().up(db());
    await db()
      .collection('platformSettings')
      .updateOne({ key: 'whatsappBilling' }, { $set: { 'value.markupBps': 2500 } });
    await migration().up(db());
    expect(
      (await db().collection('platformSettings').findOne({ key: 'whatsappBilling' }))?.value
        .markupBps,
    ).toBe(2500);
    expect(await db().collection('whatsappRateCards').countDocuments()).toBe(1);
  });

  it('refuses to roll back while WhatsApp charges exist, else removes everything', async () => {
    await migration().up(db());
    const charge = await db().collection('ledgerEntries').insertOne({ type: 'whatsapp_charge' });
    await expect(migration().down(db())).rejects.toThrow(
      '0012-templates-billing: refusing to roll back',
    );
    await db().collection('ledgerEntries').deleteOne({ _id: charge.insertedId });

    const account = await db()
      .collection('accounts')
      .insertOne({
        name: 'N',
        slug: 'p11-mig-n',
        settings: { recordingEnabled: true, templates: DEFAULT_TEMPLATE_SETTINGS },
        whatsappBilling: { markupBps: 1, fixedPrices: null, platformFeeMicros: null },
      });
    const wallet = await db()
      .collection('wallets')
      .insertOne({
        budgets: { monthlyCallMicros: 0, monthlyWhatsappMicros: 7 },
        spend: { callMicros: 0, whatsappMicros: 3 },
      });
    const contact = await db()
      .collection('contacts')
      .insertOne({
        phoneE164: '+919000099120',
        whatsapp: { waId: '919000099120', marketing: { stopped: true } },
      });
    const channel = await db()
      .collection('whatsappChannels')
      .insertOne({ label: 'x', pricingTier: [{ category: 'utility', tier: 't', at: new Date() }] });
    const role = await db()
      .collection('roles')
      .insertOne({
        key: 'owner',
        isSystem: true,
        permissions: ['templates.read', 'templates.manage', 'calls.read'],
      });
    await migration().down(db());

    const left = await collections();
    for (const name of TEMPLATE_BILLING_COLLECTIONS) expect(left).not.toContain(name);
    const indexNames = (await db().collection('messages').indexes()).map((i) => i.name);
    expect(indexNames).not.toContain('billing_held_at');
    expect(indexNames).not.toContain('template_contact_at');
    const acc = await db().collection('accounts').findOne({ _id: account.insertedId });
    expect(acc?.settings).toEqual({ recordingEnabled: true });
    expect(acc).not.toHaveProperty('whatsappBilling');
    expect(await db().collection('wallets').findOne({ _id: wallet.insertedId })).toMatchObject({
      budgets: { monthlyCallMicros: 0 },
      spend: { callMicros: 0 },
    });
    const w = await db().collection('wallets').findOne({ _id: wallet.insertedId });
    expect(w?.budgets).not.toHaveProperty('monthlyWhatsappMicros');
    expect(w?.spend).not.toHaveProperty('whatsappMicros');
    expect(
      (await db().collection('contacts').findOne({ _id: contact.insertedId }))?.whatsapp,
    ).toEqual({ waId: '919000099120' });
    expect(
      await db().collection('whatsappChannels').findOne({ _id: channel.insertedId }),
    ).not.toHaveProperty('pricingTier');
    expect((await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions).toEqual(
      ['calls.read'],
    );
    await db().collection('accounts').deleteOne({ _id: account.insertedId });
    await db().collection('wallets').deleteOne({ _id: wallet.insertedId });
    await db().collection('contacts').deleteOne({ _id: contact.insertedId });
    await db().collection('whatsappChannels').deleteOne({ _id: channel.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });

    await migration().down(db());
    await migration().up(db());
    expect(await collections()).toEqual(expect.arrayContaining([...TEMPLATE_BILLING_COLLECTIONS]));
  });
});
