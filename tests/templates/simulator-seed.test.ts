import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { SEED_INBOX_CUSTOMERS, seedInbox } from '../../scripts/seed-inbox';
import { SEED_TEMPLATE_NAMES, seedTemplates } from '../../scripts/seed-templates';
import { seedWhatsApp } from '../../scripts/seed-whatsapp';
import { credit, holdForWhatsApp } from '../../src/core/billing/engine';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { createInboxHooks } from '../../src/modules/inbox/hooks';
import { recordingInboxJobs } from '../../src/modules/inbox/jobs';
import { runTemplateSimulator } from '../../src/modules/templates/simulator';
import {
  isTemplateSimulatorKind,
  TEMPLATE_SIMULATOR_KINDS,
  templateSimulatorPermission,
} from '../../src/modules/templates/simulator-kinds';
import { createTemplate } from '../../src/modules/templates/template.service';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { createWhatsAppBillingHook } from '../../src/modules/whatsapp-billing/billing-hook';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useTemplateWorld } from '../helpers/templates';
import { buildTestApp } from '../helpers/test-app';
import { userActor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const t = useTemplateWorld();
const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const queued: string[] = [];
const waJobs = { enqueueEvent: (id: string) => (queued.push(id), Promise.resolve()) };

/** Runs a kind, then processes the stored events like the worker (with the inbox billing hook). */
const sim = async (
  kind: (typeof TEMPLATE_SIMULATOR_KINDS)[number],
  opts: Record<string, string> = {},
) => {
  const r = await runTemplateSimulator(
    { ctx: t.w.ctx, jobs: waJobs, storage: t.storage },
    t.state.channel._id,
    kind,
    opts,
  );
  for (const id of queued.splice(0))
    await processWebhookEvent(t.state.h, id, { finalAttempt: true });
  return r;
};

let users: Awaited<ReturnType<typeof t.setup>>['users'];
let templateId: string;
beforeEach(async () => {
  ({ users } = await t.setup());
  queued.length = 0;
  const r = await createTemplate(
    t.state.tx,
    t.state.acc.account._id,
    userActor(users.owner.user._id),
    {
      channelId: t.state.channel._id.toString(),
      name: `sim_${randomUUID().slice(0, 6)}_instant`,
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    },
  );
  templateId = r.id;
  await WhatsAppTemplateModel.updateOne(
    { _id: templateId },
    { $set: { lastEventAt: new Date(0) } },
  );
});

const row = () => WhatsAppTemplateModel.findById(templateId).lean();

describe('template simulator — 14 kinds', () => {
  it('catalogue and permissions', () => {
    expect(TEMPLATE_SIMULATOR_KINDS).toHaveLength(14);
    expect(isTemplateSimulatorKind('template_paused')).toBe(true);
    expect(isTemplateSimulatorKind('inbound_text')).toBe(false);
    expect(templateSimulatorPermission('template_rejected')).toBe('templates.manage');
    expect(templateSimulatorPermission('run_template_sync')).toBe('templates.manage');
    expect(templateSimulatorPermission('user_stopped_marketing')).toBe('inbox.reply');
    expect(templateSimulatorPermission('late_billable_status')).toBe('inbox.reply');
    expect(templateSimulatorPermission('run_hold_reaper')).toBe('whatsapp.manage');
  });

  it('template status / quality / category / components through the real pipeline', async () => {
    await sim('template_rejected', { templateId });
    expect(await row()).toMatchObject({
      status: 'REJECTED',
      statusReason: { reason: 'INVALID_FORMAT' },
    });
    await sim('template_approved', { templateId });
    expect((await row())?.status).toBe('APPROVED');
    await sim('template_paused', { templateId });
    expect((await row())?.status).toBe('PAUSED');
    await sim('template_disabled', { templateId });
    expect((await row())?.status).toBe('DISABLED');
    await sim('template_quality_red', { templateId });
    expect((await row())?.quality?.score).toBe('RED');
    await sim('template_category_changed', { templateId });
    expect((await row())?.category).toBe('MARKETING');
    await sim('template_components_changed', { templateId });
    expect(t.jobs.syncs.some((s) => s.reason === 'webhook')).toBe(true);
    const fake = await t.w.fake.templates(t.state.channel.wabaId);
    expect(fake[0]).toMatchObject({ status: 'DISABLED', category: 'MARKETING' });
    expect(
      await NotificationModel.countDocuments({
        accountId: t.state.acc.account._id,
        type: 'template.rejected',
      }),
    ).toBeGreaterThan(0);
    await expect(sim('template_approved')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('marketing preferences, tier update, sync, reaper, reconcile, late billable status', async () => {
    const accountId = t.state.acc.account._id;
    const contact = await ContactModel.create({
      accountId,
      phoneE164: '+919000099777',
      source: { type: 'whatsapp' },
      whatsapp: { waId: '919000099777' },
    });
    await sim('user_stopped_marketing', { from: '919000099777' });
    expect((await ContactModel.findById(contact._id).lean())?.whatsapp?.marketing?.stopped).toBe(
      true,
    );
    await sim('user_resumed_marketing', { from: '919000099777' });
    expect((await ContactModel.findById(contact._id).lean())?.whatsapp?.marketing?.stopped).toBe(
      false,
    );
    await sim('pricing_tier_update');
    expect(
      (await WhatsAppChannelModel.findById(t.state.channel._id).lean())?.pricingTier,
    ).toHaveLength(1);
    expect((await sim('run_template_sync')).result).toMatchObject({ created: 0, deleted: 0 });
    expect((await sim('run_whatsapp_reconcile')).result).toMatchObject({ failed: 0 });

    // a held message: the reaper (as if 72 h passed) releases it; a billable status then charges late
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 1_000_000,
      ref: { type: 'manual', id: 's' },
      idempotencyKey: `sim-${accountId.toString()}`,
    });
    const clientId = randomUUID();
    const hold = await holdForWhatsApp({
      accountId,
      clientId,
      amountMicros: 140_000,
      breakdown: { waCategory: 'utility', waMarket: 'IN' },
      ref: { type: 'whatsapp_message', id: clientId },
    });
    const msg = await MessageModel.create({
      accountId,
      channelId: t.state.channel._id,
      contactId: contact._id,
      conversationId: new Types.ObjectId(),
      direction: 'out',
      origin: 'agent',
      type: 'text',
      status: 'read',
      waMessageId: `wamid.SIMLATE${clientId.slice(0, 8)}`,
      at: new Date(),
      billing: {
        payer: 'platform',
        market: 'IN',
        category: 'utility',
        estimateMicros: 140_000,
        priceMicros: 140_000,
        holdId: hold.entries[0]!._id,
        status: 'held',
        at: new Date(),
      },
    });
    expect((await sim('run_hold_reaper')).result).toEqual({ released: 1 });
    expect((await MessageModel.findById(msg._id).lean())?.billing?.status).toBe('released');
    // statuses go through the inbox hooks; this context also carries the billing hook
    t.state.h.inbox = createInboxHooks({
      wa: t.w.ctx,
      storage: t.storage,
      jobs: recordingInboxJobs(),
      billing: createWhatsAppBillingHook(),
    });
    await sim('late_billable_status', { messageId: msg._id.toString() });
    expect((await MessageModel.findById(msg._id).lean())?.billing?.status).toBe('late_charged');
    expect(
      await LedgerEntryModel.countDocuments({
        accountId,
        type: 'whatsapp_charge',
        idempotencyKey: `wa-late-${msg._id.toString()}`,
      }),
    ).toBe(1);
    await expect(sim('late_billable_status')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('dev routes', () => {
  const app = () =>
    buildTestApp(
      { MOCK_APIS_ENABLED: 'true' },
      { whatsapp: { ctx: t.w.ctx, jobs: waJobs, storage: t.storage } },
    );

  it('POST /dev/meta/webhooks takes template kinds (permission per kind); GET /dev/meta/templates', async () => {
    const res = await request(app())
      .post('/api/v1/dev/meta/webhooks')
      .set(bearer(users.manager.token))
      .send({ channelId: t.state.channel._id.toString(), kind: 'template_paused', templateId });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      kind: 'template_paused',
      field: 'message_template_status_update',
      received: 1,
    });
    expect(
      (
        await request(app())
          .post('/api/v1/dev/meta/webhooks')
          .set(bearer(users.agent.token))
          .send({ channelId: t.state.channel._id.toString(), kind: 'template_paused', templateId })
      ).status,
    ).toBe(403);
    const list = await request(app())
      .get(`/api/v1/dev/meta/templates?channelId=${t.state.channel._id.toString()}`)
      .set(bearer(users.viewer.token));
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toEqual({
      id: expect.stringMatching(/^fake_tpl_/),
      name: expect.any(String),
      language: 'en',
      status: 'PAUSED',
      category: 'UTILITY',
      quality: 'UNKNOWN',
    });
    expect(JSON.stringify(list.body)).not.toContain('EMI is due');
  });
});

describe('seedTemplates', () => {
  it('Demo Finance: 4 templates (approved / approved / pending / rejected), one charged send — once', async () => {
    const acc = await createTestAccount({ name: 'Demo Finance' });
    const owner = await acc.addUser('owner');
    const deps = {
      env: t.w.env,
      ownerId: owner.user._id,
      redis: t.w.redis,
      logger: createLogger(t.w.env),
      storage: t.storage,
    };
    expect(await seedTemplates(acc.account._id, deps)).toMatchObject({
      skipped: 'No demo WhatsApp number',
    });
    await WhatsAppChannelModel.deleteMany({ displayPhoneNumber: '+91 90000 12345' });
    await seedWhatsApp(acc.account._id, deps);
    await credit({
      accountId: acc.account._id,
      type: 'topup',
      amountMicros: 100_000_000,
      ref: { type: 'manual', id: 'seed' },
      idempotencyKey: `seed-tpl-${acc.account._id.toString()}`,
    });
    await seedInbox(acc.account._id, deps);
    // like `db:seed`: the contact fields come first
    for (const [key, type] of [
      ['emi_amount', 'currency'],
      ['due_date', 'date'],
    ] as const) {
      await CustomFieldModel.create({ accountId: acc.account._id, key, label: key, type });
    }
    const first = await seedTemplates(acc.account._id, deps);
    expect(first).toEqual({ templates: 4, charged: 1, skipped: null });
    const byName = Object.fromEntries(
      (await WhatsAppTemplateModel.find({ accountId: acc.account._id }).lean()).map((x) => [
        x.name,
        x,
      ]),
    );
    expect(byName[SEED_TEMPLATE_NAMES.emi]).toMatchObject({
      status: 'APPROVED',
      category: 'UTILITY',
    });
    expect(byName[SEED_TEMPLATE_NAMES.emi]?.variables.map((v) => v.defaultSource.kind)).toEqual([
      'field',
      'field',
    ]);
    expect(byName[SEED_TEMPLATE_NAMES.offer]).toMatchObject({
      status: 'APPROVED',
      category: 'MARKETING',
    });
    expect(byName.call_permission_en).toMatchObject({
      status: 'PENDING',
      purpose: 'call_permission',
    });
    expect(byName[SEED_TEMPLATE_NAMES.rejected]).toMatchObject({
      status: 'REJECTED',
      statusReason: { reason: 'PROMOTIONAL' },
    });
    const billing = await MessageModel.find({
      accountId: acc.account._id,
      billing: { $ne: null },
    }).lean();
    expect(billing.map((m) => m.billing?.status).sort()).toEqual(
      expect.arrayContaining(['captured', 'released']),
    );
    expect(billing.find((m) => m.type === 'template')?.text).toBe(
      'Namaste, your EMI of ₹12,500.00 is due on 05 Nov 2026. Please pay on time to avoid charges.\n\nDemo Finance',
    );
    expect(await seedTemplates(acc.account._id, deps)).toEqual({
      templates: 0,
      charged: 0,
      skipped: null,
    });
    expect(SEED_INBOX_CUSTOMERS.closed).toBeTruthy();
  });
});
