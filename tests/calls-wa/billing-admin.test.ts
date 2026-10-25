import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { credit, holdForWhatsAppCall } from '../../src/core/billing/engine';
import { reapStaleHolds } from '../../src/core/billing/reaper';
import { diffCallingCards, parseCallingRateCsv } from '../../src/core/billing/whatsapp-calls';
import { reapWhatsAppHolds } from '../../src/core/billing/whatsapp-reaper';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppRateCardModel } from '../../src/db/models/whatsapp-rate-card.model';
import { viewOne } from '../../src/modules/calls/calls.service';
import { quoteCall } from '../../src/modules/whatsapp-calling/billing';
import {
  reapWhatsAppCallHolds,
  reconcileWhatsAppCalls,
} from '../../src/modules/whatsapp-calling/maintenance';
import { createTestAccount } from '../helpers/auth';
import { expectWalletConsistent } from '../helpers/billing';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useTemplateWorld } from '../helpers/templates';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const t = useTemplateWorld();
const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: t.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        storage: t.storage,
        templateJobs: t.jobs,
      },
    },
  );

let users: Awaited<ReturnType<typeof t.setup>>['users'];
beforeEach(async () => {
  ({ users } = await t.setup());
  await WhatsAppRateCardModel.deleteMany({ kind: 'calling' });
  await PlatformSettingsModel.deleteMany({ key: 'whatsappCalling' });
});

const csv = (...rows: string[]) =>
  Buffer.from(['Market,Currency,Per minute,50000+,250000+', ...rows].join('\n'));

describe('calling rate card CSV', () => {
  it('reads tolerant headers, tiers and calling codes; INR only; one OTHER market', () => {
    const ok = parseCallingRateCsv(csv('India,INR,0.3885,0.36,', 'Other,INR,1.00,,'));
    expect(ok.errors).toEqual([]);
    expect(ok.markets).toEqual([
      {
        market: 'IN',
        label: 'India',
        callingCodes: ['91'],
        perMinuteMicros: 388_500,
        tiers: [{ fromMinutes: 50_000, perMinuteMicros: 360_000 }],
      },
      { market: 'OTHER', label: 'Other', callingCodes: [], perMinuteMicros: 1_000_000, tiers: [] },
    ]);
    const alt = parseCallingRateCsv(
      Buffer.from(
        '﻿country, calling codes ,rate_per_minute\r\nAtlantis,"999; 998",0.5\r\nRest of world,,1\r\n',
      ),
    );
    expect(alt.errors).toEqual([]);
    expect(alt.markets[0]).toMatchObject({ market: 'ATLANTIS', callingCodes: ['999', '998'] });

    expect(parseCallingRateCsv(csv('India,USD,0.3,,', 'Other,INR,1,,')).errors).toEqual([
      { row: 2, message: 'Only INR rate cards can be imported' },
    ]);
    expect(parseCallingRateCsv(csv('India,INR,abc,,', 'Other,INR,1,,')).errors[0]?.message).toMatch(
      /Bad per minute rate/,
    );
    expect(
      parseCallingRateCsv(csv('India,INR,0.3,x,', 'Other,INR,1,,')).errors[0]?.message,
    ).toMatch(/Bad tier rate/);
    expect(
      parseCallingRateCsv(csv('Atlantis,INR,0.3,,', 'Other,INR,1,,')).errors[0]?.message,
    ).toMatch(/calling codes/);
    expect(parseCallingRateCsv(csv('India,INR,0.3,,')).errors).toEqual([
      { row: 0, message: 'Exactly one OTHER market is required' },
    ]);
    expect(parseCallingRateCsv(Buffer.from('Market,Colour\nIndia,red')).errors).toEqual(
      expect.arrayContaining([{ row: 1, message: 'Unknown column "Colour"' }]),
    );
    expect(parseCallingRateCsv(Buffer.from('Market\nIndia')).errors).toEqual([
      { row: 1, message: 'Missing column "perMinute"' },
    ]);
    expect(parseCallingRateCsv(Buffer.from('')).errors).toEqual([
      { row: 1, message: 'The file is empty' },
    ]);
    expect(parseCallingRateCsv(Buffer.alloc(3 * 1024 * 1024, 'a')).errors[0]?.row).toBe(0);
  });

  it('diffs a new card against the one in force', () => {
    const a = parseCallingRateCsv(csv('India,INR,0.3885,,', 'Other,INR,1,,')).markets;
    const b = parseCallingRateCsv(
      csv('India,INR,0.40,0.35,', 'Pakistan,INR,0.9,,', 'Other,INR,1,,'),
    ).markets;
    expect(diffCallingCards(a, b)).toEqual({
      added: ['PK'],
      removed: [],
      changed: [
        { market: 'IN', field: 'perMinuteMicros', fromMicros: 388_500, toMicros: 400_000 },
        { market: 'IN', field: 'tiers', fromMicros: null, toMicros: null },
      ],
    });
    expect(diffCallingCards(b, a).removed).toEqual(['PK']);
  });
});

describe('/admin WhatsApp calling billing (superadmin)', () => {
  const superadmin = async () => {
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `p-wac-${String(Date.now())}`,
      name: 'P',
    });
    return platform.addUser('owner', { platformRole: 'superadmin' });
  };

  it('calling card import → save → prices; call settings; account override; wallet rates; margin rows', async () => {
    const sa = await superadmin();
    const a = app();
    const accountId = t.state.acc.account._id;
    const quote = () => quoteCall({ accountId, phoneE164: '+919000000101', payer: 'platform' });
    expect(
      (
        await request(a)
          .get('/api/v1/admin/whatsapp-rates?kind=calling')
          .set(bearer(users.owner.token))
      ).status,
    ).toBe(403);
    const preview = await request(a)
      .post('/api/v1/admin/whatsapp-rates/import?kind=calling')
      .set(bearer(sa.token))
      .attach('file', csv('India,INR,0.50,,', 'Other,INR,1.20,,'), {
        filename: 'calls.csv',
        contentType: 'text/csv',
      });
    expect(preview.status).toBe(200);
    expect(preview.body.data.errors).toEqual([]);
    expect(preview.body.data.diff.changed).toContainEqual({
      market: 'IN',
      field: 'perMinuteMicros',
      fromMicros: 388_500,
      toMicros: 500_000,
    });
    expect(
      (
        await request(a)
          .post('/api/v1/admin/whatsapp-rates/import?kind=nope')
          .set(bearer(sa.token))
          .attach('file', csv('Other,INR,1,,'), { filename: 'c.csv', contentType: 'text/csv' })
      ).status,
    ).toBe(422);
    // a calling body on a messaging card (and the reverse) is refused
    expect(
      (
        await request(a)
          .post('/api/v1/admin/whatsapp-rates')
          .set(bearer(sa.token))
          .send({ kind: 'calling', source: 'meta_csv' })
      ).status,
    ).toBe(422);
    const saved = await request(a).post('/api/v1/admin/whatsapp-rates').set(bearer(sa.token)).send({
      kind: 'calling',
      callingMarkets: preview.body.data.callingMarkets,
      source: 'meta_csv',
      note: 'Calling card',
    });
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({ kind: 'calling', note: 'Calling card' });
    const list = await request(a)
      .get('/api/v1/admin/whatsapp-rates?kind=calling')
      .set(bearer(sa.token));
    expect(list.body.data.current.callingMarkets).toHaveLength(2);
    expect(list.body.data.history).toHaveLength(1);
    // the messaging list never shows calling cards
    const messaging = await request(a).get('/api/v1/admin/whatsapp-rates').set(bearer(sa.token));
    expect(JSON.stringify(messaging.body.data)).not.toContain('Calling card');
    expect(await quote()).toMatchObject({
      market: 'IN',
      perMinuteMicros: 500_000,
      markupBps: 1500,
    });

    const settings = await request(a)
      .patch('/api/v1/admin/whatsapp-billing')
      .set(bearer(sa.token))
      .send({ calling: { markupBps: 2000, platformFeePerMinuteMicros: 10_000, holdMinutes: 3 } });
    expect(settings.status).toBe(200);
    expect(settings.body.data.calling).toMatchObject({
      markupBps: 2000,
      platformFeePerMinuteMicros: 10_000,
      holdMinutes: 3,
      holdExtendMinutes: 5,
    });
    expect(
      (
        await request(a)
          .patch('/api/v1/admin/whatsapp-billing')
          .set(bearer(sa.token))
          .send({ calling: {} })
      ).status,
    ).toBe(422);
    expect(await quote()).toMatchObject({ markupBps: 2000, platformFeePerMinuteMicros: 10_000 });

    await RateCardModel.create({
      accountId: null,
      ...DEFAULT_RATE_CARD,
      effectiveFrom: new Date(0),
    });
    const rates = async () =>
      (
        (await request(a).get('/api/v1/wallet/rates').set(bearer(users.owner.token))).body as {
          data: { whatsappCalling: { markets: { perMinuteMicros: number }[] } };
        }
      ).data.whatsappCalling;
    // 0.50 × 1.20 = 0.60 + fee 0.01 → ₹0.61 a minute (selling price only)
    expect(await rates()).toEqual({
      payer: 'platform',
      pulseSec: 6,
      markets: [
        { market: 'IN', label: 'India', perMinuteMicros: 610_000 },
        { market: 'OTHER', label: 'Other', perMinuteMicros: 1_450_000 },
      ],
    });

    const path = `/api/v1/admin/accounts/${accountId.toString()}/whatsapp-billing`;
    const override = await request(a)
      .patch(path)
      .set(bearer(sa.token))
      .send({ calling: { fixedPerMinuteMicros: 450_000 } });
    expect(override.status).toBe(200);
    expect(override.body.data.whatsappCallingBilling).toEqual({
      markupBps: null,
      fixedPerMinuteMicros: 450_000,
      platformFeePerMinuteMicros: null,
    });
    expect((await rates()).markets[0]?.perMinuteMicros).toBe(460_000);
    await request(a).patch(path).set(bearer(sa.token)).send({ calling: null });
    expect((await quote()).fixedPerMinuteMicros).toBeNull();
    expect(
      await AuditLogModel.countDocuments({
        action: {
          $in: [
            'whatsapp.rate_card_saved',
            'whatsapp.billing_settings_updated',
            'account.whatsapp_billing_updated',
          ],
        },
        'meta.kind': { $ne: 'messaging' },
      }),
    ).toBeGreaterThanOrEqual(3);

    // margin: settled call charges per account (kind `call`); ours-time rows are mismatches
    const callId = new Types.ObjectId();
    await LedgerEntryModel.create({
      accountId,
      type: 'whatsapp_call_charge',
      direction: 'debit',
      status: 'captured',
      amountMicros: 90_000,
      breakdown: { kind: 'whatsapp_call', metaCostMicros: 77_700, waPulses: 2 },
      ref: { type: 'call', id: callId.toString() },
      idempotencyKey: `wa-call-settle-${callId.toString()}`,
      note: 'Meta duration not received in time — our measured talk time',
    });
    const month = new Date().toISOString().slice(0, 7);
    const margin = await request(a)
      .get(`/api/v1/admin/reports/whatsapp-margin?month=${month}`)
      .set(bearer(sa.token));
    expect(margin.body.data).toContainEqual(
      expect.objectContaining({
        kind: 'call',
        category: 'call',
        messages: 1,
        billedMicros: 90_000,
        metaCostMicros: 77_700,
        marginMicros: 12_300,
        mismatches: 1,
      }),
    );
    const csvRes = await request(a)
      .get(`/api/v1/admin/reports/whatsapp-margin?month=${month}&format=csv`)
      .set(bearer(sa.token));
    expect(csvRes.text).toContain('Kind');
    expect(csvRes.text).toContain(',call,call,');
  });
});

describe('WhatsApp call hold maintenance', () => {
  const age = (key: string, hours: number) =>
    LedgerEntryModel.collection.updateOne(
      { idempotencyKey: key },
      { $set: { createdAt: new Date(Date.now() - hours * 3_600_000) } },
    );

  it('the Phase 4 and Phase 11 reapers leave call holds; the call reaper releases only stale ones', async () => {
    const acc = await createTestAccount();
    const accountId = acc.account._id;
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 10_000_000,
      ref: { type: 'manual', id: 'wa-call-reaper' },
      idempotencyKey: `wa-call-reaper-${accountId.toString()}`,
    });
    const stale = new Types.ObjectId();
    const fresh = new Types.ObjectId();
    await CallModel.create({
      _id: stale,
      accountId,
      direction: 'outbound',
      provider: 'whatsapp',
      from: 'whatsapp:x',
      to: '+919000000101',
      source: { kind: null },
      status: 'failed',
      timestamps: { queuedAt: new Date() },
      billing: {
        whatsapp: { payer: 'platform', market: 'IN', perMinuteMicros: 1, status: 'held' },
      },
    });
    for (const id of [stale, fresh])
      await holdForWhatsAppCall({
        accountId,
        callId: id.toString(),
        amountMicros: 500_000,
        breakdown: { waMarket: 'IN' },
      });
    await age(`wa-call-hold-${stale.toString()}`, 100);
    await age(`wa-call-hold-${fresh.toString()}`, 0.5);
    // other reapers: not their type
    expect(await reapStaleHolds()).toEqual({ released: 0 });
    expect(await reapWhatsAppHolds()).toEqual({ released: 0 });
    expect((await WalletModel.findOne({ accountId }).lean())?.holdMicros).toBe(1_000_000);

    expect(await reapWhatsAppCallHolds()).toEqual({ released: 1 });
    expect(await reapWhatsAppCallHolds()).toEqual({ released: 0 }); // idempotent
    const rows = await LedgerEntryModel.find({ accountId, type: 'whatsapp_call_charge' }).lean();
    expect(rows.map((r) => [r.ref.id, r.status]).sort()).toEqual(
      [
        [stale.toString(), 'released'],
        [fresh.toString(), 'held'],
      ].sort(),
    );
    expect((await CallModel.findById(stale).lean())?.billing.whatsapp?.status).toBe('released');
    expect((await WalletModel.findOne({ accountId }).lean())?.holdMicros).toBe(500_000);
    await expectWalletConsistent(accountId);
  });

  it('reconcile stores Meta’s late pulses beside the ones we charged, once', async () => {
    const acc = await createTestAccount();
    const base = {
      accountId: acc.account._id,
      direction: 'outbound' as const,
      provider: 'whatsapp' as const,
      from: 'whatsapp:x',
      to: '+919000000101',
      source: { kind: null },
      status: 'completed' as const,
      timestamps: { queuedAt: new Date() },
    };
    const late = await CallModel.create({
      ...base,
      whatsapp: {
        channelId: new Types.ObjectId(),
        direction: 'BUSINESS_INITIATED',
        metaDuration: 13,
      },
      billing: {
        whatsapp: {
          payer: 'platform',
          market: 'IN',
          perMinuteMicros: 388_500,
          pulses: 2,
          status: 'settled',
          durationSource: 'ours',
        },
      },
    });
    const same = await CallModel.create({
      ...base,
      whatsapp: {
        channelId: new Types.ObjectId(),
        direction: 'BUSINESS_INITIATED',
        metaDuration: 12,
      },
      billing: {
        whatsapp: {
          payer: 'platform',
          market: 'IN',
          perMinuteMicros: 388_500,
          pulses: 2,
          status: 'settled',
          durationSource: 'ours',
        },
      },
    });
    await CallModel.create({
      ...base,
      whatsapp: {
        channelId: new Types.ObjectId(),
        direction: 'BUSINESS_INITIATED',
        metaDuration: 30,
      },
      billing: {
        whatsapp: {
          payer: 'platform',
          market: 'IN',
          perMinuteMicros: 388_500,
          pulses: 5,
          status: 'settled',
          durationSource: 'meta',
        },
      },
    });
    expect(await reconcileWhatsAppCalls()).toEqual({ checked: 2, mismatches: 1 });
    expect((await CallModel.findById(late._id).lean())?.billing.whatsapp?.metaLatePulses).toBe(3);
    expect((await CallModel.findById(same._id).lean())?.billing.whatsapp?.metaLatePulses).toBe(2);
    expect(await reconcileWhatsAppCalls()).toEqual({ checked: 0, mismatches: 0 });
  });
});

describe('account views of a WhatsApp call charge', () => {
  it('show the selling price only: no Meta cost, markup or fee on calls or ledger responses', async () => {
    const acc = await createTestAccount();
    const owner = await acc.addUser('owner');
    const accountId = acc.account._id;
    const callId = new Types.ObjectId();
    await CallModel.create({
      _id: callId,
      accountId,
      direction: 'outbound',
      provider: 'whatsapp',
      from: 'whatsapp:x',
      to: '+919000000102',
      source: { kind: null },
      status: 'completed',
      timestamps: { queuedAt: new Date() },
      whatsapp: {
        channelId: new Types.ObjectId(),
        direction: 'BUSINESS_INITIATED',
        metaDuration: 12,
      },
      billing: {
        whatsapp: {
          payer: 'platform',
          market: 'IN',
          perMinuteMicros: 388_500,
          pulses: 2,
          metaCostMicros: 77_700,
          markupMicros: 11_655,
          platformFeeMicros: 645,
          status: 'settled',
          durationSource: 'meta',
        },
      },
      cost: { telephonyMicros: 90_000, totalMicros: 90_000 },
    });
    const entry = await LedgerEntryModel.create({
      accountId,
      type: 'whatsapp_call_charge',
      direction: 'debit',
      status: 'captured',
      amountMicros: 90_000,
      breakdown: {
        kind: 'whatsapp_call',
        waMarket: 'IN',
        waPulses: 2,
        metaCostMicros: 77_700,
        markupMicros: 11_655,
        platformFeeMicros: 645,
      },
      ref: { type: 'call', id: callId.toString() },
      idempotencyKey: `wa-call-settle-${callId.toString()}`,
    });
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const hiddenParts = ['metaCost', 'markupMicros', 'platformFee', '77700', '11655'];
    // the call page and the calls list share this view
    const call = await CallModel.findById(callId).lean<CallDoc>();
    const view = JSON.stringify(await viewOne(call!));
    expect(view).toContain('90000');
    for (const hidden of hiddenParts) expect(view, hidden).not.toContain(hidden);
    const a = app();
    const views = [
      '/api/v1/wallet/ledger',
      `/api/v1/wallet/ledger/${entry._id.toString()}`,
      `/api/v1/wallet/ledger/export?from=${day(-1)}&to=${day(1)}`,
    ];
    for (const path of views) {
      const res = await request(a).get(path).set(bearer(owner.token));
      expect(res.status, `${path} ${res.text.slice(0, 200)}`).toBe(200);
      const body = res.text;
      expect(body, path).toMatch(/90000|0\.09/);
      for (const hidden of hiddenParts) expect(body, `${path} ${hidden}`).not.toContain(hidden);
    }
  });
});
