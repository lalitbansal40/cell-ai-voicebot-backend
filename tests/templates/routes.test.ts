import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { MessageModel } from '../../src/db/models/message.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppRateCardModel } from '../../src/db/models/whatsapp-rate-card.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { invalidateWhatsAppPricingCache } from '../../src/modules/whatsapp-billing/pricing.service';
import { createTestAccount, tokenFor } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { mediaFixture } from '../helpers/inbox';
import { useTemplateWorld } from '../helpers/templates';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const t = useTemplateWorld();
const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const base = '/api/v1/whatsapp/templates';
const app = (env: NodeJS.ProcessEnv = {}) =>
  buildTestApp(env, {
    whatsapp: {
      ctx: t.w.ctx,
      jobs: { enqueueEvent: () => Promise.resolve() },
      storage: t.storage,
      templateJobs: t.jobs,
    },
  });
const BODY = 'Hi {{1}}, your EMI of the month is due — ZQ-ROUTE-BODY.';
const createBody = (name: string, over: Record<string, unknown> = {}) => ({
  channelId: t.state.channel._id.toString(),
  name,
  language: 'en',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: BODY, example: { body_text: [['A']] } }],
  ...over,
});

let users: Awaited<ReturnType<typeof t.setup>>['users'];
let n = 0;
beforeEach(async () => {
  ({ users } = await t.setup());
  n += 1;
});

describe('/whatsapp/templates — roles and views', () => {
  it('managers create / edit / submit / delete; agents and viewers only read; list rows have no bodies', async () => {
    const a = app();
    for (const role of ['agent', 'viewer'] as const) {
      const res = await request(a)
        .post(base)
        .set(bearer(users[role].token))
        .send(createBody(`no_${role}`));
      expect(res.status, role).toBe(403);
    }
    const created = await request(a)
      .post(base)
      .set(bearer(users.manager.token))
      .send(createBody(`r${String(n)}_slow`, { submit: false }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: 'DRAFT',
      components: [{ type: 'BODY', text: BODY }],
    });
    const id = created.body.data.id as string;
    for (const role of ['owner', 'admin', 'manager', 'agent', 'viewer'] as const) {
      const list = await request(a).get(base).set(bearer(users[role].token));
      expect(list.status, role).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain('ZQ-ROUTE-BODY');
      expect((await request(a).get(`${base}/${id}`).set(bearer(users[role].token))).status).toBe(
        200,
      );
    }
    const edited = await request(a)
      .patch(`${base}/${id}`)
      .set(bearer(users.admin.token))
      .send({
        components: [
          { type: 'BODY', text: 'Hello {{1}}, updated text.', example: { body_text: [['B']] } },
        ],
      });
    expect(edited.status).toBe(200);
    const submitted = await request(a).post(`${base}/${id}/submit`).set(bearer(users.owner.token));
    expect(submitted.body.data).toMatchObject({ status: 'PENDING', submitted: true });
    expect(
      (
        await request(a)
          .patch(`${base}/${id}/variables`)
          .set(bearer(users.manager.token))
          .send({ sources: [{ key: '1', kind: 'contact.name' }] })
      ).body.data.variables[0].defaultSource,
    ).toEqual({ kind: 'contact.name', value: null });
    const del = await request(a)
      .delete(`${base}/${id}?scope=name`)
      .set(bearer(users.manager.token));
    expect(del.body.data).toEqual({ deleted: 1 });
    expect((await request(a).get(base).set(bearer(users.owner.token))).body.data).toEqual([]);
    expect(
      (await request(a).get(`${base}?includeDeleted=true`).set(bearer(users.owner.token))).body
        .data,
    ).toHaveLength(1);
    expect(
      await AuditLogModel.countDocuments({
        accountId: t.state.acc.account._id,
        action: /^template\./,
      }),
    ).toBeGreaterThanOrEqual(5);
  });

  it('filters, validation and Meta errors', async () => {
    const a = app();
    await request(a)
      .post(base)
      .set(bearer(users.owner.token))
      .send(createBody(`util${String(n)}_instant`));
    await request(a)
      .post(base)
      .set(bearer(users.owner.token))
      .send(createBody(`mkt${String(n)}_slow`, { category: 'MARKETING' }));
    const q = (qs: string) => request(a).get(`${base}?${qs}`).set(bearer(users.owner.token));
    expect((await q('status=APPROVED')).body.data.map((x: { name: string }) => x.name)).toEqual([
      `util${String(n)}_instant`,
    ]);
    expect((await q('category=MARKETING')).body.data).toHaveLength(1);
    expect((await q('status=APPROVED,PENDING')).body.data).toHaveLength(2);
    expect((await q(`q=mkt${String(n)}`)).body.data).toHaveLength(1);
    expect((await q(`channelId=${t.state.channel._id.toString()}`)).body.data).toHaveLength(2);
    expect((await q('status=NOPE')).status).toBe(422);
    const bad = await request(a)
      .post(base)
      .set(bearer(users.owner.token))
      .send(createBody('Bad Name'));
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('name');
    const dup = await request(a)
      .post(base)
      .set(bearer(users.owner.token))
      .send(createBody(`util${String(n)}_instant`));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TEMPLATE_NAME_TAKEN');
    expect(
      (
        await request(a)
          .patch(`${base}/${'0'.repeat(24)}`)
          .set(bearer(users.owner.token))
          .send({ ttlSeconds: 60 })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(a)
          .patch(`${base}/${'0'.repeat(24)}`)
          .set(bearer(users.owner.token))
          .send({})
      ).status,
    ).toBe(422);
  });

  it('another account’s templates are 404 and never listed', async () => {
    const a = app();
    const mine = await request(a)
      .post(base)
      .set(bearer(users.owner.token))
      .send(createBody(`mine${String(n)}_slow`, { submit: false }));
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    expect((await request(a).get(base).set(bearer(otherOwner.token))).body.data).toEqual([]);
    for (const [method, path] of [
      ['get', `${base}/${mine.body.data.id as string}`],
      ['patch', `${base}/${mine.body.data.id as string}`],
      ['post', `${base}/${mine.body.data.id as string}/submit`],
      ['delete', `${base}/${mine.body.data.id as string}`],
    ] as const) {
      const res = await request(a)
        [method](path)
        .set(bearer(otherOwner.token))
        .send({ ttlSeconds: 60 });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(
      (await request(a).post(base).set(bearer(otherOwner.token)).send(createBody('steal'))).status,
    ).toBe(404);
  });

  it('impersonators and suspended accounts read only; WhatsApp off → 503', async () => {
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `p-tpl-${String(Date.now())}`,
      name: 'P',
    });
    const superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
    const imp = await tokenFor(users.owner.user, { imp: superadmin.user._id.toString() });
    const a = app();
    expect((await request(a).get(base).set(bearer(imp))).status).toBe(200);
    expect((await request(a).post(base).set(bearer(imp)).send(createBody('imp_try'))).status).toBe(
      403,
    );
    await AccountModel.updateOne(
      { _id: t.state.acc.account._id },
      { $set: { status: 'suspended' } },
    );
    expect((await request(a).get(base).set(bearer(users.owner.token))).status).toBe(200);
    expect(
      (await request(a).post(base).set(bearer(users.owner.token)).send(createBody('susp_try')))
        .status,
    ).toBe(403);
    await AccountModel.updateOne({ _id: t.state.acc.account._id }, { $set: { status: 'active' } });
    const off = buildTestApp({ WHATSAPP_ENABLED: 'false' });
    const res = await request(off).get(base).set(bearer(users.owner.token));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('WHATSAPP_NOT_CONFIGURED');
  });

  it('sync (1 / min / number), call permission template, header example upload', async () => {
    const a = app();
    const channelId = t.state.channel._id.toString();
    const first = await request(a)
      .post(`${base}/sync`)
      .set(bearer(users.manager.token))
      .send({ channelId });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 0 });
    const second = await request(a)
      .post(`${base}/sync`)
      .set(bearer(users.manager.token))
      .send({ channelId });
    expect(second.status).toBe(429);
    const cp = await request(a)
      .post(`${base}/call-permission`)
      .set(bearer(users.owner.token))
      .send({ channelId, submit: false });
    expect(cp.status).toBe(201);
    expect(cp.body.data).toMatchObject({
      purpose: 'call_permission',
      category: 'UTILITY',
      status: 'DRAFT',
    });
    const media = await request(a)
      .post(base)
      .set(bearer(users.owner.token))
      .send(
        createBody(`img${String(n)}`, {
          category: 'MARKETING',
          submit: false,
          components: [
            { type: 'HEADER', format: 'IMAGE' },
            { type: 'BODY', text: 'Look at this offer.' },
          ],
        }),
      );
    const up = await request(a)
      .post(`${base}/${media.body.data.id as string}/media`)
      .set(bearer(users.owner.token))
      .attach('file', mediaFixture('sample.png'), {
        filename: 'offer.png',
        contentType: 'image/png',
      });
    expect(up.status).toBe(200);
    expect(up.body.data.headerMedia).toMatchObject({ mimeType: 'image/png', uploaded: true });
    expect(JSON.stringify(up.body)).not.toContain('storageKey');
    expect(
      (
        await request(a)
          .post(`${base}/${media.body.data.id as string}/media`)
          .set(bearer(users.owner.token))
      ).status,
    ).toBe(422);
  });
});

describe('wallet: WhatsApp prices, budget, ledger filter, usage', () => {
  it('rates show selling prices per market; usage and ledger know WhatsApp', async () => {
    await RateCardModel.create({
      accountId: null,
      ...DEFAULT_RATE_CARD,
      effectiveFrom: new Date(0),
    });
    invalidateWhatsAppPricingCache();
    const a = app();
    const rates = await request(a).get('/api/v1/wallet/rates').set(bearer(users.owner.token));
    expect(rates.status, JSON.stringify(rates.body)).toBe(200);
    expect(rates.body.data.whatsapp).toMatchObject({ payer: 'platform' });
    expect(rates.body.data.whatsapp.markets[0]).toEqual({
      market: 'IN',
      label: 'India',
      prices: { marketing: 1_000_000, utility: 140_000, authentication: 140_000, service: 140_000 },
    });
    expect(JSON.stringify(rates.body)).not.toContain('863100');
    const ledger = await request(a)
      .get('/api/v1/wallet/ledger?type=whatsapp_charge')
      .set(bearer(users.owner.token));
    expect(ledger.status).toBe(200);
    const usage = await request(a).get('/api/v1/wallet/usage').set(bearer(users.owner.token));
    expect(usage.body.data.totals).toHaveProperty('whatsappMicros');
  });
});

describe('/admin WhatsApp billing (superadmin)', () => {
  const superadmin = async () => {
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `p-wab-${String(Date.now())}`,
      name: 'P',
    });
    return platform.addUser('owner', { platformRole: 'superadmin' });
  };
  const csv = [
    'Market,Currency,Marketing,Utility,Authentication,Authentication-International,Service',
    'India,INR,0.9,0.12,0.12,,0.12',
    'Other,INR,1.5,0.5,0.5,,0.3',
  ].join('\n');

  it('rate card import preview → save → prices change; global settings; account override; reports', async () => {
    const sa = await superadmin();
    const a = app();
    await WhatsAppRateCardModel.deleteMany({});
    await PlatformSettingsModel.deleteMany({});
    invalidateWhatsAppPricingCache();
    expect(
      (await request(a).get('/api/v1/admin/whatsapp-rates').set(bearer(users.owner.token))).status,
    ).toBe(403);
    const preview = await request(a)
      .post('/api/v1/admin/whatsapp-rates/import')
      .set(bearer(sa.token))
      .attach('file', Buffer.from(csv), { filename: 'rates.csv', contentType: 'text/csv' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.errors).toEqual([]);
    expect(preview.body.data.diff.changed).toContainEqual({
      market: 'IN',
      field: 'marketingMicros',
      fromMicros: 863_100,
      toMicros: 900_000,
    });
    const saved = await request(a)
      .post('/api/v1/admin/whatsapp-rates')
      .set(bearer(sa.token))
      .send({ markets: preview.body.data.markets, source: 'meta_csv', note: 'October card' });
    expect(saved.status).toBe(201);
    const list = await request(a).get('/api/v1/admin/whatsapp-rates').set(bearer(sa.token));
    expect(list.body.data.current).toMatchObject({ source: 'meta_csv', note: 'October card' });
    const price = () =>
      request(a).post('/api/v1/whatsapp/price-preview').set(bearer(users.owner.token)).send({
        channelId: t.state.channel._id.toString(),
        phone: '+919000000101',
        category: 'marketing',
      });
    expect((await price()).body.data.priceMicros).toBe(1_040_000); // 0.9 × 1.15 = 1.035 → ₹1.04
    expect(
      (
        await request(a).post('/api/v1/admin/whatsapp-rates').set(bearer(sa.token)).send({
          markets: preview.body.data.markets,
          source: 'manual',
          effectiveFrom: '2020-01-01T00:00:00Z',
        })
      ).status,
    ).toBe(422);
    const settings = await request(a)
      .patch('/api/v1/admin/whatsapp-billing')
      .set(bearer(sa.token))
      .send({ markupBps: 2000 });
    expect(settings.body.data.settings).toMatchObject({ markupBps: 2000, holdMaxAgeHours: 72 });
    expect((await price()).body.data.priceMicros).toBe(1_080_000);
    await WhatsAppChannelModel.updateOne(
      { _id: t.state.channel._id },
      { $set: { wabaCurrency: 'USD' } },
    );
    expect(
      (await request(a).get('/api/v1/admin/whatsapp-billing').set(bearer(sa.token))).body.data
        .nonInrPlatformChannels,
    ).toEqual([
      expect.objectContaining({ channelId: t.state.channel._id.toString(), wabaCurrency: 'USD' }),
    ]);
    const override = await request(a)
      .patch(`/api/v1/admin/accounts/${t.state.acc.account._id.toString()}/whatsapp-billing`)
      .set(bearer(sa.token))
      .send({ fixedPrices: { marketing: 750_000 }, platformFeeMicros: 10_000 });
    expect(override.body.data.whatsappBilling).toEqual({
      markupBps: null,
      fixedPrices: { marketing: 750_000 },
      platformFeeMicros: 10_000,
    });
    expect((await price()).body.data.priceMicros).toBe(760_000);
    expect(
      (
        await request(a)
          .patch(`/api/v1/admin/accounts/${t.state.acc.account._id.toString()}/whatsapp-billing`)
          .set(bearer(sa.token))
          .send({})
      ).status,
    ).toBe(422);
    expect(
      await AuditLogModel.countDocuments({
        action: {
          $in: [
            'whatsapp.rate_card_saved',
            'whatsapp.billing_settings_updated',
            'account.whatsapp_billing_updated',
          ],
        },
      }),
    ).toBeGreaterThanOrEqual(3);

    // margin + reconciliation reports
    const month = new Date().toISOString().slice(0, 7);
    await MessageModel.create({
      accountId: t.state.acc.account._id,
      channelId: t.state.channel._id,
      contactId: t.state.acc.account._id,
      conversationId: t.state.acc.account._id,
      direction: 'out',
      origin: 'agent',
      type: 'template',
      status: 'delivered',
      at: new Date(),
      billing: {
        payer: 'platform',
        market: 'IN',
        category: 'utility',
        estimateMicros: 140_000,
        priceMicros: 140_000,
        metaCostMicros: 115_000,
        status: 'captured',
        categoryMismatch: true,
        at: new Date(),
      },
    });
    const margin = await request(a)
      .get(`/api/v1/admin/reports/whatsapp-margin?month=${month}`)
      .set(bearer(sa.token));
    expect(margin.body.data).toEqual([
      expect.objectContaining({
        category: 'utility',
        messages: 1,
        billedMicros: 140_000,
        metaCostMicros: 115_000,
        metaCostSource: 'list',
        marginMicros: 25_000,
        marginBps: 1786,
        mismatches: 1,
      }),
    ]);
    const csvRes = await request(a)
      .get(`/api/v1/admin/reports/whatsapp-margin?month=${month}&format=csv`)
      .set(bearer(sa.token));
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.text).toContain('Margin (INR)');
    expect(csvRes.text).toContain('0.03'); // ₹0.025 → paise
    expect(
      (
        await request(a)
          .get(`/api/v1/admin/reports/whatsapp-reconciliation?month=${month}`)
          .set(bearer(sa.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(a)
          .get('/api/v1/admin/reports/whatsapp-margin?month=2026-13')
          .set(bearer(sa.token))
      ).status,
    ).toBe(422);
    await PlatformSettingsModel.deleteMany({});
    invalidateWhatsAppPricingCache();
  });

  it('bad CSV → row errors, no diff', async () => {
    const sa = await superadmin();
    const res = await request(app())
      .post('/api/v1/admin/whatsapp-rates/import')
      .set(bearer(sa.token))
      .attach('file', Buffer.from('Market,Marketing\nIndia,abc'), {
        filename: 'x.csv',
        contentType: 'text/csv',
      });
    expect(res.body.data).toMatchObject({ markets: [], diff: null });
    expect(res.body.data.errors.length).toBeGreaterThan(0);
    expect(await WhatsAppTemplateModel.countDocuments({ accountId: t.state.acc.account._id })).toBe(
      0,
    );
  });
});
