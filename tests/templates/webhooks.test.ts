import { Writable } from 'node:stream';

import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderTemplate } from '../../src/core/email';
import { setRealtime } from '../../src/core/realtime';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../src/db/models/whatsapp-template.model';
import {
  hasDeferredTemplateEvents,
  runTemplatesBackfill,
} from '../../src/modules/templates/backfill.job';
import { setMarketingPreference } from '../../src/modules/templates/marketing';
import { createTemplate } from '../../src/modules/templates/template.service';
import { createLogger, setLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useTemplateWorld } from '../helpers/templates';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const t = useTemplateWorld();
const emails = useCapturedEmail();

const events: { type: string; data: unknown }[] = [];
const logLines: string[] = [];
beforeEach(() => {
  events.length = 0;
  emails.length = 0;
  logLines.length = 0;
  setRealtime({
    pushToAccount: (_target: string, type: string, data: unknown) => {
      events.push({ type, data });
      return Promise.resolve();
    },
    pushToUser: () => Promise.resolve(),
    pushToTopic: () => Promise.resolve(),
  } as never);
  setLogger(
    createLogger(
      { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
      new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      }),
    ),
  );
});
afterEach(() => {
  setRealtime(undefined);
  setLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

const BODY = 'Dear {{1}}, the secret ZXQ-WEBHOOK-BODY is waiting for you.';

/** A submitted template on the current channel. */
const submitted = async (
  accountId: Types.ObjectId,
  creator: Types.ObjectId,
  name = 'hook_test',
) => {
  const d = await createTemplate(t.state.tx, accountId, userActor(creator), {
    channelId: t.state.channel._id.toString(),
    name,
    language: 'en',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: BODY, example: { body_text: [['Asha']] } }],
  });
  const row = await WhatsAppTemplateModel.findById(d.id).lean<WhatsAppTemplateDoc>();
  if (!row?.metaTemplateId) throw new Error('not submitted');
  // the webhooks below are "received" after the submit
  await WhatsAppTemplateModel.updateOne({ _id: row._id }, { $set: { lastEventAt: new Date(0) } });
  return row;
};

const status = (row: WhatsAppTemplateDoc, event: string, extra: Record<string, unknown> = {}) =>
  t.envelope('message_template_status_update', {
    event,
    message_template_id: row.metaTemplateId,
    message_template_name: row.name,
    message_template_language: row.language,
    message_template_category: row.category,
    reason: 'NONE',
    ...extra,
  });

const fresh = async (id: Types.ObjectId) =>
  (await WhatsAppTemplateModel.findById(id).lean<WhatsAppTemplateDoc>()) as WhatsAppTemplateDoc;

describe('template status webhooks', () => {
  it('approved → status, history, WS, audit and a bell for managers + the creator (no body)', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.agent.user._id);
    expect(await t.deliver(status(row, 'APPROVED'))).toEqual(['processed']);
    const after = await fresh(row._id);
    expect(after.status).toBe('APPROVED');
    expect(after.statusHistory.at(-1)).toMatchObject({ status: 'APPROVED', source: 'webhook' });
    expect(events).toContainEqual({
      type: 'whatsapp.template.updated',
      data: {
        templateId: row._id.toString(),
        status: 'APPROVED',
        quality: null,
        category: 'UTILITY',
      },
    });
    const bells = await NotificationModel.find({ accountId, type: 'template.approved' }).lean();
    const to = bells.map((b) => b.userId.toString()).sort();
    expect(to).toEqual(
      [users.owner, users.admin, users.manager, users.agent]
        .map((u) => u.user._id.toString())
        .sort(),
    );
    expect(bells[0]).toMatchObject({
      title: 'Template approved',
      body: 'hook_test (en)',
      link: `/whatsapp/templates?id=${row._id.toString()}`,
    });
    expect(emails).toEqual([]);
    expect(
      await AuditLogModel.findOne({ accountId, action: 'template.status_changed' }).lean(),
    ).toMatchObject({ meta: { from: 'PENDING', to: 'APPROVED', name: 'hook_test' } });
    expect(JSON.stringify(await NotificationModel.find({ accountId }).lean())).not.toContain(
      'ZXQ-WEBHOOK-BODY',
    );
    expect(logLines.join('')).not.toContain('ZXQ-WEBHOOK-BODY');
  });

  it('rejected (reason text + e-mail), paused (until, FIRST_PAUSE), disabled (e-mail), reinstated', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.owner.user._id);
    await t.deliver(
      status(row, 'REJECTED', {
        reason: 'INVALID_FORMAT',
        rejection_info: { reason: 'Bad', recommendation: 'Fix the variables' },
      }),
    );
    let after = await fresh(row._id);
    expect(after).toMatchObject({
      status: 'REJECTED',
      statusReason: { reason: 'INVALID_FORMAT', title: 'Bad', description: 'Fix the variables' },
    });
    const rejected = await NotificationModel.findOne({
      accountId,
      type: 'template.rejected',
    }).lean();
    expect(rejected?.body).toBe(
      'hook_test (en): the format is not valid (check variables and examples)',
    );
    expect(emails.map((e) => e.template)).toEqual(expect.arrayContaining(['template.rejected']));
    expect(new Set(emails.map((e) => e.to)).size).toBe(emails.length);
    const mail = renderTemplate('template.rejected', emails[0]?.vars as never);
    expect(mail.subject).toBe('Your WhatsApp template was rejected');
    expect(mail.text).not.toContain('ZXQ-WEBHOOK-BODY');

    await t.deliver(
      status(row, 'PAUSED', { other_info: { title: 'FIRST_PAUSE', description: 'Low quality' } }),
    );
    after = await fresh(row._id);
    expect(after.status).toBe('PAUSED');
    expect(after.pausedUntil?.getTime()).toBeGreaterThan(Date.now() + 2.9 * 3_600_000);
    await t.deliver(status(row, 'DISABLED', { disable_info: { disable_date: 1761206400 } }));
    expect((await fresh(row._id)).status).toBe('DISABLED');
    expect(emails.filter((e) => e.template === 'template.disabled').length).toBeGreaterThan(0);
    await t.deliver(status(row, 'REINSTATED'));
    expect((await fresh(row._id)).status).toBe('APPROVED');
    // LOCKED keeps the status, records the reason
    await t.deliver(status(row, 'LOCKED', { other_info: { title: 'DISABLED', description: 'x' } }));
    expect(await fresh(row._id)).toMatchObject({
      status: 'APPROVED',
      statusReason: { reason: 'DISABLED' },
    });
  });

  it('a Meta category in the status event updates ours and keeps the previous one', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.owner.user._id);
    await t.deliver(status(row, 'APPROVED', { message_template_category: 'MARKETING' }));
    expect(await fresh(row._id)).toMatchObject({
      category: 'MARKETING',
      previousCategory: 'UTILITY',
    });
  });

  it('unknown template id → a sync is queued; older events than the row are ignored', async () => {
    const { accountId, users } = await t.setup();
    await t.deliver(
      t.envelope('message_template_status_update', {
        event: 'APPROVED',
        message_template_id: 'not-ours',
        message_template_name: 'x',
        message_template_language: 'en',
      }),
    );
    expect(t.jobs.syncs).toEqual([
      { channelId: t.state.channel._id.toString(), reason: 'webhook' },
    ]);
    const row = await submitted(accountId, users.owner.user._id, 'stale_test');
    await WhatsAppTemplateModel.updateOne(
      { _id: row._id },
      { $set: { lastEventAt: new Date(Date.now() + 3_600_000), status: 'APPROVED' } },
    );
    await t.deliver(status(row, 'REJECTED', { reason: 'SCAM' }));
    expect((await fresh(row._id)).status).toBe('APPROVED');
  });

  it('schema errors fail the event (no retry loop)', async () => {
    await t.setup();
    expect(
      await t.deliver(t.envelope('message_template_quality_update', { message_template_id: 1 })),
    ).toEqual(['failed']);
  });
});

describe('quality, category and components webhooks', () => {
  it('quality RED → bell once; older score ignored', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.owner.user._id);
    const quality = (score: string) =>
      t.envelope('message_template_quality_update', {
        previous_quality_score: 'GREEN',
        new_quality_score: score,
        message_template_id: row.metaTemplateId,
        message_template_name: row.name,
        message_template_language: row.language,
      });
    await t.deliver(quality('RED'));
    expect((await fresh(row._id)).quality?.score).toBe('RED');
    expect(
      await NotificationModel.countDocuments({ accountId, type: 'template.quality_low' }),
    ).toBe(3);
    await t.deliver({
      ...quality('RED'),
      entry: [{ ...(quality('RED').entry[0] as object), time: 1 }],
    });
    expect(
      await NotificationModel.countDocuments({ accountId, type: 'template.quality_low' }),
    ).toBe(3);
    await t.deliver(quality('GREEN'));
    expect((await fresh(row._id)).quality?.score).toBe('GREEN');
  });

  it('category: pending notice (bell only) and the done change (category + audit + bell)', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.owner.user._id);
    const ref = {
      message_template_id: row.metaTemplateId,
      message_template_name: row.name,
      message_template_language: row.language,
    };
    await t.deliver(
      t.envelope('template_category_update', {
        ...ref,
        correct_category: 'MARKETING',
        new_category: 'UTILITY',
        category_update_timestamp: 1793145600,
      }),
    );
    expect((await fresh(row._id)).category).toBe('UTILITY');
    const pending = await NotificationModel.findOne({
      accountId,
      type: 'template.category_changed',
    }).lean();
    expect(pending?.body).toContain('will change the category to marketing');
    await t.deliver(
      t.envelope('template_category_update', {
        ...ref,
        previous_category: 'UTILITY',
        new_category: 'MARKETING',
      }),
    );
    expect(await fresh(row._id)).toMatchObject({
      category: 'MARKETING',
      previousCategory: 'UTILITY',
    });
    expect(
      await AuditLogModel.findOne({ accountId, action: 'template.category_changed' }).lean(),
    ).toMatchObject({ meta: { from: 'UTILITY', to: 'MARKETING' } });
  });

  it('components update → a sync is queued (the exact components come from Meta)', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.owner.user._id);
    await t.deliver(
      t.envelope('message_template_components_update', {
        message_template_id: row.metaTemplateId,
        message_template_name: row.name,
        message_template_language: row.language,
        message_template_element: 'New text',
      }),
    );
    expect(t.jobs.syncs).toEqual([
      { channelId: t.state.channel._id.toString(), reason: 'webhook' },
    ]);
  });
});

describe('user preferences + pricing tier', () => {
  const prefs = (waId: string, value: string, ts: number) =>
    t.envelope('user_preferences', {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: t.state.channel.displayPhoneNumber,
        phone_number_id: t.state.channel.phoneNumberId,
      },
      user_preferences: [
        { wa_id: waId, detail: 'x', category: 'marketing_messages', value, timestamp: ts },
      ],
    });

  it('stop / resume → the contact flag (by waId or phone), newest wins, other accounts untouched', async () => {
    const { accountId } = await t.setup();
    const wa = await ContactModel.create({
      accountId,
      phoneE164: '+919000077001',
      source: { type: 'whatsapp' },
      whatsapp: { waId: '919000077001' },
    });
    const plain = await ContactModel.create({
      accountId,
      phoneE164: '+919000077002',
      source: { type: 'manual' },
    });
    const foreign = await ContactModel.create({
      accountId: new Types.ObjectId(),
      phoneE164: '+919000077001',
      source: { type: 'manual' },
    });
    await t.deliver(prefs('919000077001', 'stop', 1793000000));
    await t.deliver(prefs('919000077002', 'stop', 1793000000));
    const a = await ContactModel.findById(wa._id).lean();
    expect(a?.whatsapp?.marketing).toMatchObject({ stopped: true, source: 'user_preferences' });
    expect((await ContactModel.findById(plain._id).lean())?.whatsapp?.marketing?.stopped).toBe(
      true,
    );
    expect((await ContactModel.findById(foreign._id).lean())?.whatsapp ?? null).toBeNull();
    // an older resume is ignored, a newer one applies
    await t.deliver(prefs('919000077001', 'resume', 1792000000));
    expect((await ContactModel.findById(wa._id).lean())?.whatsapp?.marketing?.stopped).toBe(true);
    await t.deliver(prefs('919000077001', 'resume', 1794000000));
    expect((await ContactModel.findById(wa._id).lean())?.whatsapp?.marketing?.stopped).toBe(false);
    expect(events).toContainEqual({
      type: 'contacts.changed',
      data: { reason: 'whatsapp_marketing' },
    });
    const audit = await AuditLogModel.find({
      accountId,
      action: 'contact.whatsapp_marketing_changed',
    }).lean();
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain('919000077001');
    // error 131050 path (Phase 11 sends)
    expect(
      await setMarketingPreference({
        accountId,
        contactId: wa._id,
        stopped: true,
        source: 'error_131050',
        at: new Date(1795000000 * 1000),
      }),
    ).toBe(true);
  });

  it('volume pricing tier → channel pricingTier (last 10)', async () => {
    await t.setup();
    for (let i = 0; i < 12; i += 1) {
      await t.deliver(
        t.envelope('account_update', {
          event: 'VOLUME_BASED_PRICING_TIER_UPDATE',
          volume_tier_info: {
            tier_update_time: 1793000000 + i,
            pricing_category: 'UTILITY',
            tier: `${String(i)}:MAX`,
            effective_month: '2026-11',
            region: 'India',
          },
        }),
      );
    }
    const channel = await WhatsAppChannelModel.findById(t.state.channel._id).lean();
    expect(channel?.pricingTier).toHaveLength(10);
    expect(channel?.pricingTier?.at(-1)).toMatchObject({
      category: 'utility',
      market: 'India',
      tier: '11:MAX',
    });
  });
});

describe('deferred events + backfill', () => {
  it('without the template hooks events stay deferred; the backfill applies them in arrival order', async () => {
    const { accountId, users } = await t.setup();
    const row = await submitted(accountId, users.owner.user._id);
    const noTemplates = { ctx: t.w.ctx, service: t.w.svc };
    expect(await t.deliver(status(row, 'APPROVED'), noTemplates)).toEqual(['deferred']);
    expect(
      await t.deliver(status(row, 'PAUSED', { other_info: { title: 'FIRST_PAUSE' } }), noTemplates),
    ).toEqual(['deferred']);
    expect(await hasDeferredTemplateEvents()).toBe(true);
    const deferred = await MetaWebhookEventModel.find({
      field: 'message_template_status_update',
      status: 'deferred',
    }).lean();
    expect(deferred[0]?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 20 * 86_400_000);
    const res = await runTemplatesBackfill(t.state.tx);
    expect(res).toMatchObject({ processed: 2, failed: 0 });
    const after = await fresh(row._id);
    expect(after.status).toBe('PAUSED');
    expect(after.statusHistory.slice(-2).map((h) => h.status)).toEqual(['APPROVED', 'PAUSED']);
    expect(await hasDeferredTemplateEvents()).toBe(false);
  });
});
