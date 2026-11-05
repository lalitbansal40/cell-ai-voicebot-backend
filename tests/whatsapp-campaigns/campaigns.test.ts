import { randomUUID } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adjust } from '../../src/core/billing/engine';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { InboxUploadModel } from '../../src/db/models/inbox-upload.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppCampaignRecipientModel } from '../../src/db/models/whatsapp-campaign-recipient.model';
import { WhatsAppCampaignModel } from '../../src/db/models/whatsapp-campaign.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { processSend } from '../../src/modules/inbox/send.job';
import { createUpload } from '../../src/modules/inbox/upload.service';
import { encryptValue } from '../../src/modules/privacy/sensitive';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import { onMessageStatus } from '../../src/modules/whatsapp-billing/billing-hook';
import {
  snapshotAudience,
  skipFor,
  variantFor,
} from '../../src/modules/whatsapp-campaigns/audience';
import {
  campaignReport,
  createCampaign,
  deleteCampaign,
  estimateCampaign,
  exportRecipients,
  pauseCampaign,
  resumeCampaign,
  retryFailed,
  recentSendCount,
  startCampaign,
  stopCampaign,
  updateCampaign,
} from '../../src/modules/whatsapp-campaigns/campaigns.service';
import {
  campaignClientId,
  decideWinners,
  dispatchCampaign,
  sweepCampaigns,
} from '../../src/modules/whatsapp-campaigns/dispatch';
import { campaignHeaderFor } from '../../src/modules/whatsapp-campaigns/media';
import { allowedNow } from '../../src/modules/whatsapp-campaigns/pacing';
import {
  prepareRecurringRun,
  scheduleRecurringRuns,
} from '../../src/modules/whatsapp-campaigns/recurrence';
import {
  trackCampaignMessage,
  trackCampaignReply,
} from '../../src/modules/whatsapp-campaigns/tracking';
import { loadVariants } from '../../src/modules/whatsapp-campaigns/variants';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { mediaFixture, useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;

let users: Awaited<ReturnType<typeof world.setup>>['users'];
let utility: string;
let marketing: string;
let n = 0;
const jobs = {
  calls: [] as string[],
  enqueueDispatch(id: string) {
    this.calls.push(id);
    return Promise.resolve();
  },
};

const req = (perms: string[] = ['contacts.export']) =>
  ({
    auth: {
      kind: 'user',
      accountId: state.acc.account._id.toString(),
      userId: users.owner.user._id.toString(),
      permissions: new Set(perms),
    },
    ip: '127.0.0.1',
  }) as unknown as Request;

const template = async (category: 'UTILITY' | 'MARKETING', text: string) => {
  const t = await createTemplate(
    { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
    state.acc.account._id,
    userActor(users.owner.user._id),
    {
      channelId: state.channel._id.toString(),
      name: `c_${randomUUID().slice(0, 8)}`,
      language: 'en',
      category,
      components: [{ type: 'BODY', text, example: { body_text: [['A']] } }],
    },
  );
  await WhatsAppTemplateModel.updateOne({ _id: t.id }, { $set: { status: 'APPROVED' } });
  return t.id;
};

const contact = (over: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+9190011${String(50_000 + ++n).padStart(5, '0')}`,
    name: `Customer ${String(n)}`,
    source: { type: 'manual' },
    ...over,
  });

const draft = async (contactIds: Types.ObjectId[], over: Record<string, unknown> = {}) =>
  createCampaign(req(), {
    name: 'November reminder',
    channelId: state.channel._id.toString(),
    variants: [{ key: 'A', templateId: utility, splitPct: 100 }],
    variables: { '1': { kind: 'contact.name' } },
    audience: { contactIds: contactIds.map(String) },
    ...over,
  });

const run = async (id: string) => {
  const result = await dispatchCampaign({ ix: state.ix, sleep: () => Promise.resolve() }, id);
  const messages = await MessageModel.find({
    accountId: state.acc.account._id,
    status: 'queued',
  }).lean();
  for (const message of messages) {
    let outcome = await processSend(state.ix, message._id.toString(), {
      finalAttempt: false,
      waits: 0,
    });
    while (outcome.kind === 'later' && outcome.delayMs < 1000) {
      const delay = outcome.delayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
      outcome = await processSend(state.ix, message._id.toString(), {
        finalAttempt: false,
        waits: 0,
      });
    }
  }
  return { ...result, status: (await WhatsAppCampaignModel.findById(id).lean())?.status };
};
const counters = async (id: string) => (await WhatsAppCampaignModel.findById(id).lean())?.counters;

beforeEach(async () => {
  ({ users } = await world.setup());
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    { $set: { messagingLimitTier: 'TIER_10K', qualityRating: 'GREEN' } },
  );
  utility = await template('UTILITY', 'Hi {{1}}, your EMI is due.');
  marketing = await template('MARKETING', 'Hi {{1}}, a new offer.');
  jobs.calls.length = 0;
});

describe('continuation header and schedule boundaries', () => {
  it('requires a location header and carries it to the actual template message', async () => {
    const c = await contact();
    await WhatsAppTemplateModel.updateOne(
      { _id: utility },
      {
        $set: {
          components: [
            { type: 'HEADER', format: 'LOCATION' },
            { type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['A']] } },
          ],
        },
      },
    );
    const missing = await draft([c._id]);
    await expect(startCampaign(req(), missing.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const location = { latitude: 26.9124, longitude: 75.7873, name: 'Synthetic office' };
    const campaign = await draft([c._id], { headerLocation: location });
    await startCampaign(req(), campaign.id);
    await run(campaign.id);
    const message = await MessageModel.findOne({ externalRef: `wac:${campaign.id}` }).lean();
    expect(message?.location).toMatchObject(location);
  });

  it('reports captures whose ledger reference is the stable client ID, including a replay', async () => {
    const c = await contact();
    const campaign = await draft([c._id]);
    await startCampaign(req(), campaign.id);
    await run(campaign.id);
    const message = await MessageModel.findOne({ externalRef: `wac:${campaign.id}` }).lean();
    expect(message?.billing?.status).toBe('held');
    const event = {
      accountId: state.acc.account._id,
      messageId: message!._id,
      status: 'delivered' as const,
      pricing: {
        billable: true,
        category: 'utility',
        model: 'PMP',
        type: 'regular',
        subtype: null,
        conversationId: null,
        conversationOrigin: null,
      },
    };
    await onMessageStatus(event);
    await onMessageStatus(event);
    const report = await campaignReport(req(), campaign.id);
    expect(report.cost.chargedMicros).toBe(message!.billing!.priceMicros);
    expect(report.cost.chargedMicros).toBeGreaterThan(0);
  });

  it('keeps a future scheduled start when paused and resumed', async () => {
    const c = await contact();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const campaign = await draft([c._id], { schedule: { kind: 'at', at } });
    await startCampaign(req(), campaign.id);
    await pauseCampaign(req(), campaign.id);
    const resumed = await resumeCampaign(req(), campaign.id, jobs);
    expect(resumed.status).toBe('scheduled');
    expect(resumed.schedule.at).toBe(at);
    expect(jobs.calls).toEqual([]);
  });
});

describe('WhatsApp campaigns: rules (T19.9)', () => {
  it('pure: variant split is deterministic; tier room; skip rule order', () => {
    const id = new Types.ObjectId();
    const split = [
      { key: 'A' as const, splitPct: 50 },
      { key: 'B' as const, splitPct: 50 },
    ];
    expect(variantFor(id, split)).toBe(variantFor(id, split));
    expect(allowedNow({ tier: 'TIER_250', sentLast24h: 200 })).toBe(50);
    expect(allowedNow({ tier: null, sentLast24h: 300 })).toBe(0);
    expect(allowedNow({ tier: 'TIER_UNLIMITED', sentLast24h: 1e6 })).toBe(Infinity);
    const v = {
      key: 'A' as const,
      templateId: id,
      category: 'MARKETING',
      purpose: 'general',
      keys: ['1'],
    };
    const base = {
      phoneE164: '+919000000001',
      name: 'A',
      variables: new Map(),
      dnd: false,
      optedOutAt: null,
      whatsapp: null,
      _id: id,
    } as never;
    const facts = {
      suppressed: false,
      sentRecently: false,
      mapping: { '1': { kind: 'contact.name' as const, value: null } },
      permission: null,
      now: new Date(),
    };
    expect(skipFor({ ...(base as object), phoneE164: '12' } as never, v, facts)).toBe(
      'invalid_phone',
    );
    expect(skipFor(base, v, { ...facts, suppressed: true })).toBe('suppressed');
    expect(
      skipFor(
        { ...(base as object), whatsapp: { marketing: { stopped: true } } } as never,
        v,
        facts,
      ),
    ).toBe('marketing_stopped');
    expect(skipFor(base, v, { ...facts, sentRecently: true })).toBe('sent_recently');
    expect(skipFor({ ...(base as object), name: null } as never, v, facts)).toBe(
      'missing_variable',
    );
    const consent = { ...v, category: 'UTILITY', purpose: 'call_permission' };
    expect(
      skipFor(base, consent, { ...facts, permission: { status: 'permanent', at: null } }),
    ).toBe('already_allowed');
    expect(
      skipFor(base, consent, { ...facts, permission: { status: 'declined', at: new Date() } }),
    ).toBe('declined_recently');
    expect(campaignClientId('a', 'b')).toBe(campaignClientId('a', 'b'));
  });

  it('create validates templates, split and variable sources; edit only before start', async () => {
    const c = await contact();
    await expect(
      draft([c._id], {
        variants: [{ key: 'A', templateId: new Types.ObjectId().toString(), splitPct: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      draft([c._id], { variants: [{ key: 'A', templateId: utility, splitPct: 60 }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(draft([c._id], { variables: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const d = await draft([c._id]);
    expect(d.status).toBe('draft');
    const edited = await updateCampaign(req(), d.id, {
      name: 'Renamed',
      channelId: state.channel._id.toString(),
      variants: [{ key: 'A', templateId: utility, splitPct: 100 }],
      variables: { '1': { kind: 'static', value: 'friend' } },
      audience: { contactIds: [c._id.toString()] },
    });
    expect(edited.name).toBe('Renamed');
  });

  it('a csv upload audience selects the import job contacts (T19.9)', async () => {
    const importJobId = new Types.ObjectId();
    const fromCsv = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919005500001',
      name: 'Imported',
      source: { type: 'import', importJobId },
    });
    const c = await contact();
    // audience = the import job's contacts (not the plain contact)
    const d = await createCampaign(req(), {
      name: 'Csv batch',
      channelId: state.channel._id.toString(),
      variants: [{ key: 'A', templateId: utility, splitPct: 100 }],
      variables: { '1': { kind: 'contact.name' } },
      audience: { csvUploadId: importJobId.toString() },
    });
    const started = await startCampaign(req(), d.id, jobs);
    expect(started.status).toBe('running');
    expect(started.counters).toMatchObject({ total: 1, skippedTotal: 0 });
    expect(
      await WhatsAppCampaignRecipientModel.countDocuments({
        campaignId: d.id,
        contactId: fromCsv._id,
        status: 'pending',
      }),
    ).toBe(1);
    // an unknown import job → empty audience, refused
    const d2 = await createCampaign(req(), {
      name: 'No import',
      channelId: state.channel._id.toString(),
      variants: [{ key: 'A', templateId: utility, splitPct: 100 }],
      variables: { '1': { kind: 'contact.name' } },
      audience: { csvUploadId: new Types.ObjectId().toString() },
    });
    await expect(startCampaign(req(), d2.id, jobs)).rejects.toMatchObject({
      code: 'WA_CAMPAIGN_AUDIENCE_EMPTY',
    });
    // the plain contact was never in scope
    expect(
      await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: d.id, contactId: c._id }),
    ).toBe(0);
  });
});

describe('WhatsApp campaigns: send, pace, results (T19.10–T19.12)', () => {
  it('start snapshots + skips, sends through the template path, counters, no double send on a re-run', async () => {
    const ok = await Promise.all([1, 2, 3].map(() => contact()));
    const dnd = await contact({ dnd: true });
    const opted = await contact({ optedOutAt: new Date() });
    const blocked = await contact({ whatsapp: { blocked: true } });
    const noName = await contact({ name: null });
    const d = await draft([...ok, dnd, opted, blocked, noName].map((c) => c._id));
    const est = await estimateCampaign(req(), d.id);
    expect(est).toMatchObject({
      recipients: 3,
      enough: true,
      skipped: { dnd: 1, opted_out: 1, no_whatsapp: 1, missing_variable: 1 },
    });
    const started = await startCampaign(req(), d.id, jobs);
    expect(started.status).toBe('running');
    expect(jobs.calls).toEqual([d.id]);
    expect(started.counters).toMatchObject({
      total: 7,
      skippedTotal: 4,
      skipped: { dnd: 1, opted_out: 1, no_whatsapp: 1, missing_variable: 1 },
    });
    expect(await run(d.id)).toMatchObject({ status: 'completed', sent: 3 });
    const msgs = await MessageModel.find({
      accountId: state.acc.account._id,
      type: 'template',
      'template.templateId': new Types.ObjectId(utility),
    }).lean();
    expect(msgs).toHaveLength(3);
    expect((await WhatsAppCampaignModel.findById(d.id).lean())?.status).toBe('completed');
    // a crash lost one recipient's link to its message: it goes out again with the same client id
    const one = await WhatsAppCampaignRecipientModel.findOne({
      campaignId: d.id,
      status: { $ne: 'skipped' },
    });
    await WhatsAppCampaignRecipientModel.updateOne(
      { _id: one?._id },
      { $set: { status: 'pending', messageId: null } },
    );
    await WhatsAppCampaignModel.updateOne({ _id: d.id }, { $set: { status: 'running' } });
    await run(d.id);
    expect(
      await MessageModel.countDocuments({
        accountId: state.acc.account._id,
        type: 'template',
        'template.templateId': new Types.ObjectId(utility),
      }),
    ).toBe(3);
  });

  it('empty audience and a short wallet refuse the start', async () => {
    const d1 = await draft([(await contact({ dnd: true }))._id]);
    await expect(startCampaign(req(), d1.id, jobs)).rejects.toMatchObject({
      code: 'WA_CAMPAIGN_AUDIENCE_EMPTY',
    });
    const w = await WalletModel.findOne({ accountId: state.acc.account._id }).lean();
    await adjust({
      accountId: state.acc.account._id,
      direction: 'debit',
      amountMicros: w?.balanceMicros ?? 0,
      idempotencyKey: randomUUID(),
      reason: 'drain',
      createdBy: users.owner.user._id,
    });
    const d2 = await draft([(await contact())._id]);
    await expect(startCampaign(req(), d2.id, jobs)).rejects.toMatchObject({
      code: 'WALLET_INSUFFICIENT_BALANCE',
    });
  });

  it('tier pacing waits; pause / resume / stop; template paused auto-pauses', async () => {
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { messagingLimitTier: 'TIER_50' } },
    );
    const cs = await Promise.all(Array.from({ length: 55 }, () => contact()));
    const d = await draft(cs.map((c) => c._id));
    await startCampaign(req(), d.id, jobs);
    expect(await run(d.id)).toMatchObject({ status: 'waiting_for_limit', sent: 50 });
    const waiting = await WhatsAppCampaignModel.findById(d.id).lean();
    expect(waiting?.nextBatchAt).toBeInstanceOf(Date);
    expect((await pauseCampaign(req(), d.id)).status).toBe('paused');
    expect((await resumeCampaign(req(), d.id, jobs)).status).toBe('running');
    await WhatsAppTemplateModel.updateOne({ _id: utility }, { $set: { status: 'PAUSED' } });
    expect(await run(d.id)).toMatchObject({ status: 'paused' });
    expect((await WhatsAppCampaignModel.findById(d.id).lean())?.pauseReason).toBe(
      'template_paused',
    );
    const stopped = await stopCampaign(req(), d.id);
    expect(stopped.status).toBe('stopped');
    expect(stopped.counters.skipped.stopped).toBe(5);
  });

  it('an empty wallet mid-run pauses with the rest still pending', async () => {
    const cs = await Promise.all([1, 2].map(() => contact()));
    const d = await draft(cs.map((c) => c._id));
    await startCampaign(req(), d.id, jobs);
    const w = await WalletModel.findOne({ accountId: state.acc.account._id }).lean();
    await adjust({
      accountId: state.acc.account._id,
      direction: 'debit',
      amountMicros: w?.balanceMicros ?? 0,
      idempotencyKey: randomUUID(),
      reason: 'drain',
      createdBy: users.owner.user._id,
    });
    expect(await run(d.id)).toMatchObject({ status: 'paused' });
    const c = await WhatsAppCampaignModel.findById(d.id).lean();
    expect(c?.pauseReason).toBe('wallet_empty');
    expect(
      await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: d.id, status: 'pending' }),
    ).toBe(2);
  });

  it('statuses move counters forward only; a reply counts once; retry, export, report, A/B winner', async () => {
    const cs = await Promise.all([1, 2].map(() => contact()));
    const d = await draft(
      cs.map((c) => c._id),
      {
        variants: [
          { key: 'A', templateId: utility, splitPct: 50 },
          { key: 'B', templateId: marketing, splitPct: 50 },
        ],
        abWinner: { metric: 'read', afterHours: 1 },
      },
    );
    await startCampaign(req(), d.id, jobs);
    await run(d.id);
    const rows = await WhatsAppCampaignRecipientModel.find({ campaignId: d.id }).lean();
    const [first, second] = rows;
    if (!first?.messageId || !second?.messageId) throw new Error('not sent');
    await trackCampaignMessage({ _id: first.messageId, status: 'read' });
    await trackCampaignMessage({ _id: first.messageId, status: 'delivered' });
    await trackCampaignMessage({
      _id: second.messageId,
      status: 'failed',
      error: { code: 131048 },
    });
    let k = await counters(d.id);
    expect(k).toMatchObject({ read: 1, delivered: 1, failedTotal: 1, failed: { '131048': 1 } });
    await trackCampaignReply({
      accountId: state.acc.account._id,
      contactId: first.contactId,
      at: new Date(),
    });
    await trackCampaignReply({
      accountId: state.acc.account._id,
      contactId: first.contactId,
      at: new Date(),
    });
    k = await counters(d.id);
    expect(k?.replied).toBe(1);
    expect(await retryFailed(req(), d.id, jobs)).toEqual({ retried: 1 });
    const csv = await exportRecipients(req([]), d.id);
    expect(csv.split('\n')[0]).toBe(
      'Contact,Phone,Variant,Status,Skip reason,Error code,Sent at,Replied at',
    );
    expect(csv).toMatch(/\+91••••\d{4}/);
    const report = await campaignReport(req(), d.id);
    expect(report.funnel).toMatchObject({ total: 2, read: 1, replied: 1 });
    await WhatsAppCampaignModel.updateOne(
      { _id: d.id },
      { $set: { status: 'running', startedAt: new Date(Date.now() - 2 * 3_600_000) } },
    );
    expect(await decideWinners()).toBe(1);
    expect((await WhatsAppCampaignModel.findById(d.id).lean())?.abWinner?.winner).toBe(
      first.variant,
    );
  });

  it('sweep: scheduled campaigns start when due; stale claims come back', async () => {
    const d = await draft([(await contact())._id], {
      schedule: { kind: 'at', at: new Date(Date.now() + 60_000).toISOString() },
    });
    expect((await startCampaign(req(), d.id, jobs)).status).toBe('scheduled');
    expect(jobs.calls).toEqual([]);
    await WhatsAppCampaignRecipientModel.updateMany(
      { campaignId: d.id },
      { $set: { status: 'sending', claimedAt: new Date(Date.now() - 20 * 60_000) } },
    );
    const due = await sweepCampaigns(new Date(Date.now() + 120_000));
    expect(due).toContain(d.id);
    expect((await WhatsAppCampaignModel.findById(d.id).lean())?.status).toBe('running');
    expect(
      await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: d.id, status: 'pending' }),
    ).toBe(1);
  });
});

describe('continuation: estimates, media and recurrence', () => {
  it('atomically reconciles concurrent late statuses/replies without double counters', async () => {
    const contactDoc = await contact();
    const campaign = await draft([contactDoc._id]);
    await startCampaign(req(), campaign.id);
    await dispatchCampaign({ ix: state.ix, sleep: () => Promise.resolve() }, campaign.id);
    const message = await MessageModel.findOne({ externalRef: `wac:${campaign.id}` }).lean();
    await trackCampaignMessage({ _id: message!._id, status: 'failed', error: { code: 130429 } });
    await Promise.all(
      ['read', 'delivered', 'read'].map((status) =>
        trackCampaignMessage({ _id: message!._id, status: status as 'read' | 'delivered' }),
      ),
    );
    expect(await counters(campaign.id)).toMatchObject({
      sent: 1,
      delivered: 1,
      read: 1,
      failedTotal: 0,
      queued: 0,
    });
    const reply = {
      accountId: state.acc.account._id,
      contactId: contactDoc._id,
      at: new Date(Date.now() + 1000),
    };
    await Promise.all(Array.from({ length: 5 }, () => trackCampaignReply(reply)));
    expect((await counters(campaign.id))?.replied).toBe(1);
  });

  it('rolls back a status transition when its paired campaign counter write fails', async () => {
    const campaign = await draft([(await contact())._id]);
    await startCampaign(req(), campaign.id);
    await dispatchCampaign({ ix: state.ix, sleep: () => Promise.resolve() }, campaign.id);
    const message = await MessageModel.findOne({ externalRef: `wac:${campaign.id}` }).lean();
    const fail = vi
      .spyOn(WhatsAppCampaignModel, 'updateOne')
      .mockRejectedValueOnce(new Error('Injected counter failure'));
    await trackCampaignMessage({ _id: message!._id, status: 'accepted' });
    fail.mockRestore();
    expect(
      (await WhatsAppCampaignRecipientModel.findOne({ messageId: message!._id }).lean())?.status,
    ).toBe('sending');
    expect((await counters(campaign.id))?.sent).toBe(0);
    await trackCampaignMessage({ _id: message!._id, status: 'accepted' });
    expect((await counters(campaign.id))?.sent).toBe(1);
  });

  it('opens sensitive variables only through the send resolver and keeps estimates/snapshots clean', async () => {
    await CustomFieldModel.create({
      accountId: state.acc.account._id,
      key: 'private_note',
      label: 'Private note',
      type: 'text',
      sensitive: true,
    });
    const contactDoc = await contact({
      variables: { private_note: encryptValue('SYNTHETIC_PRIVATE_SENTINEL') },
    });
    const campaign = await draft([contactDoc._id], {
      variables: { '1': { kind: 'field', value: 'private_note' } },
    });
    const estimate = await estimateCampaign(req(), campaign.id);
    expect(estimate.recipients).toBe(1);
    expect(JSON.stringify(estimate)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
    await startCampaign(req(), campaign.id);
    expect(
      JSON.stringify(await WhatsAppCampaignRecipientModel.find({ campaignId: campaign.id }).lean()),
    ).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
    await run(campaign.id);
    expect(
      (await MessageModel.findOne({ externalRef: `wac:${campaign.id}` }).lean())?.text,
    ).toContain('SYNTHETIC_PRIVATE_SENTINEL');
  });

  it('does not complete before provider acceptance and prevents queued sends while paused or stopped', async () => {
    const d = await draft([(await contact())._id]);
    await startCampaign(req(), d.id, jobs);
    expect(
      await dispatchCampaign({ ix: state.ix, sleep: () => Promise.resolve() }, d.id),
    ).toMatchObject({ status: 'running' });
    const message = await MessageModel.findOne({ externalRef: `wac:${d.id}` }).lean();
    expect(message?.status).toBe('queued');
    await pauseCampaign(req(), d.id);
    expect(
      await processSend(state.ix, message!._id.toString(), { finalAttempt: false, waits: 0 }),
    ).toMatchObject({ kind: 'later' });
    expect((await MessageModel.findById(message!._id).lean())?.waMessageId).toBeNull();
    await stopCampaign(req(), d.id);
    expect(
      await processSend(state.ix, message!._id.toString(), { finalAttempt: false, waits: 0 }),
    ).toMatchObject({ kind: 'failed' });
    expect(await counters(d.id)).toMatchObject({ sent: 0, skippedTotal: 1, failedTotal: 0 });
  });

  it('uses both assigned template categories and excludes DND without persisting a snapshot', async () => {
    const contacts = await Promise.all(Array.from({ length: 50 }, () => contact()));
    const dnd = await contact({ dnd: true });
    const d = await draft(
      [...contacts, dnd].map((c) => c._id),
      {
        variants: [
          { key: 'A', templateId: utility, splitPct: 50 },
          { key: 'B', templateId: marketing, splitPct: 50 },
        ],
        abWinner: { metric: 'read', afterHours: 6 },
      },
    );
    const estimate = await estimateCampaign(req(), d.id);
    expect(estimate.recipients).toBe(50);
    expect(estimate.skipped).toEqual({ dnd: 1 });
    expect(estimate.byMarket.map((m) => m.category).sort()).toEqual(['marketing', 'utility']);
    expect(estimate.totalMicros).toBe(
      estimate.byMarket.reduce((sum, m) => sum + m.count * m.priceMicros, 0),
    );
    expect(await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: d.id })).toBe(0);
  });
  it('makes one durable header and independent per-recipient files, rejects foreign uploads', async () => {
    const upload = await createUpload(state.ix, {
      accountId: state.acc.account._id,
      userId: users.owner.user._id,
      kind: 'image',
      bytes: mediaFixture('sample.png'),
      declaredMime: 'image/png',
    });
    await WhatsAppTemplateModel.updateOne(
      { _id: utility },
      {
        $set: {
          components: [
            { type: 'HEADER', format: 'IMAGE' },
            { type: 'BODY', text: 'Hi {{1}}' },
          ],
        },
      },
    );
    const c = await contact();
    const input = {
      name: 'Media reminders',
      channelId: state.channel._id.toString(),
      variants: [{ key: 'A' as const, templateId: utility, splitPct: 100 }],
      variables: { '1': { kind: 'contact.name' as const } },
      audience: { contactIds: [c._id.toString()] },
      headerMediaToken: upload._id.toString(),
    };
    const d = await createCampaign(req(), input, world.storage);
    expect(d.headerMedia?.kind).toBe('image');
    const saved = await WhatsAppCampaignModel.findById(d.id).lean();
    const one = await campaignHeaderFor(saved!, world.storage);
    const two = await campaignHeaderFor(saved!, world.storage);
    const copies = await InboxUploadModel.find({
      _id: { $in: [one!.mediaToken, two!.mediaToken] },
    }).lean();
    expect(new Set(copies.map((u) => u.storageKey)).size).toBe(2);
    expect(copies.every((u) => u.storageKey !== saved!.headerMedia!.storageKey)).toBe(true);
    expect(await world.storage.exists(saved!.headerMedia!.storageKey)).toBe(true);
    const savedPut = world.storage.put.bind(world.storage);
    const putFailure = vi.spyOn(world.storage, 'put');
    const deleteFailure = vi.spyOn(world.storage, 'delete');
    const fault = new Error('simulated campaign write failure');
    const createFailure = vi.spyOn(WhatsAppCampaignModel, 'create').mockRejectedValueOnce(fault);
    await expect(createCampaign(req(), input, world.storage)).rejects.toThrow(fault.message);
    expect(deleteFailure).toHaveBeenLastCalledWith(putFailure.mock.calls.at(-1)![0]);
    createFailure.mockRestore();
    const updateFailure = vi
      .spyOn(WhatsAppCampaignModel, 'findOneAndUpdate')
      .mockReturnValueOnce({ lean: () => Promise.reject(fault) } as never);
    await expect(updateCampaign(req(), d.id, input, world.storage)).rejects.toThrow(fault.message);
    expect(deleteFailure).toHaveBeenLastCalledWith(putFailure.mock.calls.at(-1)![0]);
    updateFailure.mockRestore();
    putFailure.mockImplementationOnce(async (key, bytes, options) => {
      const stored = await savedPut(key, bytes, options);
      await WhatsAppCampaignModel.updateOne({ _id: d.id }, { $set: { status: 'running' } });
      return stored;
    });
    await expect(updateCampaign(req(), d.id, input, world.storage)).rejects.toMatchObject({
      code: 'WA_CAMPAIGN_NOT_EDITABLE',
    });
    expect(deleteFailure).toHaveBeenLastCalledWith(putFailure.mock.calls.at(-1)![0]);
    expect(await world.storage.exists(saved!.headerMedia!.storageKey)).toBe(true);
    await WhatsAppCampaignModel.updateOne({ _id: d.id }, { $set: { status: 'draft' } });
    putFailure.mockRestore();
    deleteFailure.mockRestore();
    const originalKey = saved!.headerMedia!.storageKey;
    const shared = await WhatsAppCampaignModel.create({
      ...saved,
      _id: new Types.ObjectId(),
      name: 'Shared recurring copy',
    });
    await updateCampaign(req(), d.id, input, world.storage);
    const replaced = await WhatsAppCampaignModel.findById(d.id).lean();
    expect(replaced!.headerMedia!.storageKey).not.toBe(originalKey);
    expect(await world.storage.exists(originalKey)).toBe(true);
    await deleteCampaign(req(), shared._id.toString(), world.storage);
    expect(await world.storage.exists(originalKey)).toBe(false);
    await deleteCampaign(req(), d.id, world.storage);
    expect(await world.storage.exists(replaced!.headerMedia!.storageKey)).toBe(false);
    expect(await world.storage.exists(copies[0]!.storageKey)).toBe(true);
    // Invalid header validation must release the new durable copy.
    await WhatsAppTemplateModel.updateOne(
      { _id: utility },
      { $set: { components: [{ type: 'BODY', text: 'Hi {{1}}' }] } },
    );
    const put = vi.spyOn(world.storage, 'put');
    const remove = vi.spyOn(world.storage, 'delete');
    await expect(createCampaign(req(), input, world.storage)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(remove).toHaveBeenCalledWith(put.mock.calls.at(-1)![0]);
    put.mockRestore();
    remove.mockRestore();
    await InboxUploadModel.updateOne(
      { _id: upload._id },
      { $set: { accountId: new Types.ObjectId() } },
    );
    await expect(createCampaign(req(), input, world.storage)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
  it('creates one next recurring run across repeated sweeps and stops future occurrences', async () => {
    const c = await contact();
    const d = await draft([c._id], {
      schedule: {
        kind: 'recurring',
        timezone: 'UTC',
        recurrence: { freq: 'daily', days: [], time: '09:00', until: null },
      },
    });
    await WhatsAppCampaignModel.updateOne(
      { _id: d.id },
      {
        $set: {
          status: 'completed',
          startedAt: new Date('2026-11-04T09:00:00Z'),
          'schedule.at': new Date('2026-11-04T09:00:00Z'),
          createdAt: new Date('2026-11-03T00:00:00Z'),
        },
      },
    );
    const now = new Date('2026-11-04T10:00:00Z');
    await Promise.all([scheduleRecurringRuns(now), scheduleRecurringRuns(now)]);
    expect(await WhatsAppCampaignModel.countDocuments({ parentCampaignId: d.id })).toBe(1);
    const child = await WhatsAppCampaignModel.findOne({ parentCampaignId: d.id }).lean();
    expect(child?.schedule.at?.toISOString()).toBe('2026-11-05T09:00:00.000Z');
    await WhatsAppCampaignRecipientModel.create({
      campaignId: child!._id,
      accountId: state.acc.account._id,
      contactId: (await contact())._id,
      status: 'pending',
    });
    await stopCampaign(req(), d.id);
    expect(
      await WhatsAppCampaignRecipientModel.countDocuments({
        campaignId: child!._id,
        status: 'skipped',
        skipReason: 'stopped',
      }),
    ).toBe(1);
    await scheduleRecurringRuns(now);
    expect(await WhatsAppCampaignModel.countDocuments({ parentCampaignId: d.id })).toBe(1);
    expect((await WhatsAppCampaignModel.findById(child!._id).lean())?.status).toBe('stopped');
  });
  it('prepares fresh recurring audiences, pauses for funds and rejects unavailable parents or senders', async () => {
    const c = await contact();
    const root = await draft([c._id]);
    const rootDoc = await WhatsAppCampaignModel.findById(root.id).lean();
    const child = await WhatsAppCampaignModel.create({
      ...rootDoc,
      _id: new Types.ObjectId(),
      parentCampaignId: root.id,
      status: 'scheduled',
      schedule: { ...rootDoc!.schedule, at: new Date(Date.now() - 1000) },
    });
    const now = new Date();
    expect(await prepareRecurringRun(rootDoc!, now)).toBe(true);
    await WhatsAppCampaignModel.updateOne({ _id: root.id }, { $set: { status: 'paused' } });
    expect(await prepareRecurringRun(child.toObject(), now)).toBe(false);
    await WhatsAppCampaignModel.updateOne({ _id: root.id }, { $set: { status: 'completed' } });
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { status: 'disconnected' } },
    );
    expect(await prepareRecurringRun(child.toObject(), now)).toBe(false);
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { status: 'connected' } },
    );
    await WhatsAppTemplateModel.updateOne({ _id: utility }, { $set: { status: 'REJECTED' } });
    expect(await prepareRecurringRun(child.toObject(), now)).toBe(false);
    await WhatsAppTemplateModel.updateOne({ _id: utility }, { $set: { status: 'APPROVED' } });
    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 0, holdMicros: 0 } },
    );
    expect(await prepareRecurringRun(child.toObject(), now)).toBe(false);
    expect((await WhatsAppCampaignModel.findById(child._id).lean())?.pauseReason).toBe(
      'wallet_empty',
    );
    await adjust({
      accountId: state.acc.account._id,
      amountMicros: 10_000_000,
      direction: 'credit',
      reason: 'recurring funds',
      createdBy: users.owner.user._id,
      idempotencyKey: randomUUID(),
    });
    const resumed = await resumeCampaign(req(), child._id.toString(), jobs);
    expect(resumed.status).toBe('running');
    expect(resumed.counters.total).toBe(1);
    expect(await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: child._id })).toBe(1);
    const prepared = await WhatsAppCampaignModel.findById(child._id).lean();
    expect(await prepareRecurringRun(prepared!, now)).toBe(true);
    expect(await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: child._id })).toBe(1);
    const empty = await WhatsAppCampaignModel.create({
      ...rootDoc,
      _id: new Types.ObjectId(),
      parentCampaignId: root.id,
      status: 'scheduled',
      audience: { contactIds: [new Types.ObjectId()] },
    });
    expect(await prepareRecurringRun(empty.toObject(), now)).toBe(false);
    expect((await WhatsAppCampaignModel.findById(empty._id).lean())?.status).toBe('failed');
  });
  it('rejects expired schedules and keeps a repeated audience snapshot unique without hiding database errors', async () => {
    const c = await contact();
    const schedules = [
      { kind: 'at', at: '2020-01-01T00:00:00Z' },
      {
        kind: 'recurring',
        timezone: 'UTC',
        recurrence: { freq: 'weekly', days: [], time: '09:00', until: null },
      },
      {
        kind: 'recurring',
        timezone: 'UTC',
        recurrence: { freq: 'daily', days: [], time: '09:00', until: '2020-01-01T00:00:00Z' },
      },
    ];
    for (const schedule of schedules)
      await expect(draft([c._id], { schedule })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    const d = await draft([c._id]);
    await startCampaign(req(), d.id, jobs);
    expect(await recentSendCount(state.acc.account._id, new Types.ObjectId(utility), 7)).toBe(0);
    const campaign = (await WhatsAppCampaignModel.findById(d.id).lean())!;
    const variants = await loadVariants(campaign, state.channel.wabaId);
    await snapshotAudience(campaign, variants);
    expect(await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: d.id })).toBe(1);
    const failure = vi
      .spyOn(WhatsAppCampaignRecipientModel, 'insertMany')
      .mockRejectedValueOnce({ writeErrors: [{ code: 123 }] });
    try {
      await expect(snapshotAudience(campaign, variants)).rejects.toMatchObject({
        writeErrors: [{ code: 123 }],
      });
    } finally {
      failure.mockRestore();
    }
    expect(await WhatsAppCampaignRecipientModel.countDocuments({ campaignId: d.id })).toBe(1);
  });
});
