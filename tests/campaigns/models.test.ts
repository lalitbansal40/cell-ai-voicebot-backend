import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import {
  CampaignModel,
  emptyCampaignStats,
  type CampaignDoc,
} from '../../src/db/models/campaign.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const accountId = new Types.ObjectId();

const draft = (over: Record<string, unknown> = {}) => ({
  accountId,
  name: 'Recovery October',
  flowId: new Types.ObjectId(),
  schedule: { timezone: 'Asia/Kolkata' },
  window: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
  retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['no_answer', 'busy'] },
  pacing: { concurrency: 5, dialsPerMinute: 30 },
  ...over,
});

/** Creates a campaign from loose test input (invalid enums on purpose). */
const createCampaign = (over: Record<string, unknown> = {}) =>
  CampaignModel.create(draft(over) as unknown as Partial<CampaignDoc>);

describe('campaign models', () => {
  it('a draft gets defaults: dry run, empty stats, no pause, revision 1, empty history', async () => {
    await CampaignModel.syncIndexes();
    const c = await createCampaign();
    expect(c).toMatchObject({
      mode: 'dry_run',
      status: 'draft',
      pauseReason: null,
      waitingUntil: null,
      flowVersionId: null,
      versionPolicy: 'pinned',
      autoResume: true,
      revision: 1,
      parentId: null,
      deletedAt: null,
    });
    expect(c.stats).toEqual(emptyCampaignStats());
    expect(c.audience).toMatchObject({
      listIds: [],
      segmentId: null,
      filter: null,
      contactIds: [],
      excludeActiveCampaigns: true,
      skipIfMissing: [],
    });
    expect(c.followUps).toMatchObject({
      callbacks: true,
      callbackMaxDays: 7,
      promiseCheck: { enabled: false, daysAfter: 1 },
    });
    expect(c.pacing.priority).toBe('normal');
    expect(c.history).toEqual([]);
    expect(c.toJSON()).not.toHaveProperty('deletedAt');

    // unknown enums are refused
    await expect(createCampaign({ name: 'x1', mode: 'robocall' })).rejects.toThrow();
    await expect(createCampaign({ name: 'x2', status: 'done' })).rejects.toThrow();
    await expect(
      createCampaign({
        name: 'x3',
        retry: { maxAttempts: 1, intervalMinutes: 15, retryOn: ['never'] },
      }),
    ).rejects.toThrow();
  });

  it('names are unique per account among live campaigns (case-insensitive)', async () => {
    await CampaignModel.syncIndexes();
    const first = await createCampaign({ name: 'Unique Run' });
    await expect(createCampaign({ name: 'unique run' })).rejects.toThrow(/duplicate/i);
    await createCampaign({ name: 'Unique Run', accountId: new Types.ObjectId() });
    await CampaignModel.updateOne({ _id: first._id }, { deletedAt: new Date() });
    await expect(createCampaign({ name: 'Unique Run' })).resolves.toBeTruthy();
  });

  it('campaign contacts: one per contact, claim token hidden, defaults', async () => {
    await CampaignContactModel.syncIndexes();
    const campaignId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const cc = await CampaignContactModel.create({
      accountId,
      campaignId,
      contactId,
      seq: 0,
      phoneE164: '+919000500001',
      claimToken: 'secret-token',
    });
    expect(cc).toMatchObject({
      status: 'pending',
      dueRank: 2,
      attempts: 0,
      lastResult: null,
      skipReason: null,
      costMicros: 0,
    });
    expect(cc.toJSON()).not.toHaveProperty('claimToken');
    await expect(
      CampaignContactModel.create({
        accountId,
        campaignId,
        contactId,
        seq: 1,
        phoneE164: '+919000500002',
      }),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      CampaignContactModel.create({
        accountId,
        campaignId,
        contactId: new Types.ObjectId(),
        seq: 2,
        phoneE164: '+919000500003',
        skipReason: 'bored' as never,
      }),
    ).rejects.toThrow();
  });

  it('a campaign attempt is dialed once; calls without a campaign are not limited', async () => {
    await CallModel.syncIndexes();
    const base = {
      accountId,
      direction: 'outbound' as const,
      provider: 'dryrun' as 'dryrun' | 'webcall',
      from: 'dryrun',
      to: '+919000500001',
      isTest: true,
      source: { kind: 'flow' as const, flowId: new Types.ObjectId() },
      timestamps: { queuedAt: new Date() },
    };
    const campaignContactId = new Types.ObjectId();
    const call = await CallModel.create({ ...base, campaignContactId, attempt: 1, charged: false });
    expect(call).toMatchObject({ attempt: 1, charged: false, provider: 'dryrun' });
    await expect(CallModel.create({ ...base, campaignContactId, attempt: 1 })).rejects.toThrow(
      /duplicate/i,
    );
    await CallModel.create({ ...base, campaignContactId, attempt: 2 });
    await CallModel.create({ ...base });
    await CallModel.create({ ...base });
    const web = await CallModel.create({ ...base, provider: 'webcall', to: 'webcall:u' });
    expect(web).toMatchObject({ campaignContactId: null, attempt: null, charged: true });
  });

  it('account limits / call caps, contact last disposition and export kinds default', async () => {
    const account = await AccountModel.create({ name: 'Caps Co', slug: `caps-${Date.now()}` });
    expect(account.limits).toEqual({ maxConcurrentCalls: 10, dialsPerMinute: 60 });
    expect(account.settings.callCaps).toEqual({ perDay: 3, perWeek: 10, minGapMinutes: 30 });
    const contact = await ContactModel.create({
      accountId,
      phoneE164: '+919000500099',
      source: { type: 'manual' },
    });
    expect(contact.lastDisposition).toBeNull();
    const job = await ExportJobModel.create({ accountId, scope: 'filter', createdBy: accountId });
    expect(job).toMatchObject({
      kind: 'contacts',
      campaignId: null,
      format: 'csv',
      includePhone: true,
    });
    const results = await ExportJobModel.create({
      accountId,
      kind: 'campaign_results',
      campaignId: new Types.ObjectId(),
      format: 'xlsx',
      includePhone: false,
      scope: 'campaign',
      createdBy: accountId,
    });
    expect(results.scope).toBe('campaign');
    await expect(
      ExportJobModel.create({
        accountId,
        kind: 'pdf' as never,
        scope: 'filter',
        createdBy: accountId,
      }),
    ).rejects.toThrow();
  });
});
