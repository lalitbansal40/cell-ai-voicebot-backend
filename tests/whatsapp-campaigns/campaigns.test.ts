import { randomUUID } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { adjust } from '../../src/core/billing/engine';
import { ContactModel } from '../../src/db/models/contact.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppCampaignRecipientModel } from '../../src/db/models/whatsapp-campaign-recipient.model';
import { WhatsAppCampaignModel } from '../../src/db/models/whatsapp-campaign.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import { skipFor, variantFor } from '../../src/modules/whatsapp-campaigns/audience';
import {
  campaignReport,
  createCampaign,
  estimateCampaign,
  exportRecipients,
  pauseCampaign,
  resumeCampaign,
  retryFailed,
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
import { allowedNow } from '../../src/modules/whatsapp-campaigns/pacing';
import {
  trackCampaignMessage,
  trackCampaignReply,
} from '../../src/modules/whatsapp-campaigns/tracking';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
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
    phoneE164: `+9190011${String(++n).padStart(5, '0')}`,
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

const run = (id: string) => dispatchCampaign({ ix: state.ix, sleep: () => Promise.resolve() }, id);
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
    expect(est).toMatchObject({ recipients: 7, enough: true });
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
