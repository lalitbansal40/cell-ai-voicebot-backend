import type { Request } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { classifyRow, usedFields } from '../../src/modules/campaigns/audience';
import {
  beginRun,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  estimateCampaignCost,
  getCampaign,
  listCampaignContacts,
  listCampaigns,
  pauseCampaign,
  previewCampaignAudience,
  resumeCampaign,
  setCampaignHooks,
  setStatus,
  startCampaign,
  unscheduleCampaign,
  updateCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { averageDurationSec, expectedAttemptsBps } from '../../src/modules/campaigns/estimate';
import { canMoveCampaign, editRule, isFinalCampaign } from '../../src/modules/campaigns/lifecycle';
import { takeSnapshot } from '../../src/modules/campaigns/snapshot';
import { isFlowInUse } from '../../src/modules/flows/in-use';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage, aiProvider: createFakeProvider() });

let t: TestAccount;
let owner: TestUser;
let flowId: string;
let agentId: string;
let listId: string;
let inboundFlowId: string;
let draftFlowId: string;

const reqOf = (account: TestAccount, user: TestUser): Request =>
  ({
    auth: {
      kind: 'user',
      accountId: account.account._id.toString(),
      userId: user.user._id.toString(),
      permissions: new Set<string>(),
      account: {
        id: account.account._id.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  }) as unknown as Request;
let req: Request;

const phone = (n: number) => `+9190006${String(n).padStart(5, '0')}`;

beforeAll(async () => {
  await ensureRateCard();
  t = await createTestAccount({ name: 'Acme Finance' });
  owner = await t.addUser('owner');
  req = reqOf(t, owner);
  await AccountModel.updateOne(
    { _id: t.account._id },
    { 'settings.callingWindow': { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  );
  await CustomFieldModel.create([
    { accountId: t.account._id, key: 'amount', label: 'Amount', type: 'currency' },
    { accountId: t.account._id, key: 'due_date', label: 'Due date', type: 'date' },
  ]);
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(owner))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  agentId = agent.body.data.id;
  const newFlow = async (name: string, templateKey: string, publish: boolean) => {
    const created = await request(app)
      .post(FLOWS)
      .set(auth(owner))
      .send({ name, templateKey, agentIds: { ai: agentId } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (publish) {
      const published = await request(app)
        .post(`${FLOWS}/${String(created.body.data.id)}/publish`)
        .set(auth(owner))
        .send({ revision: created.body.data.revision });
      expect(published.status, JSON.stringify(published.body)).toBe(201);
    }
    return created.body.data.id as string;
  };
  flowId = await newFlow('Loan recovery', 'loan_recovery', true);
  inboundFlowId = await newFlow('Inbound', 'inbound_support', true);
  draftFlowId = await newFlow('Draft only', 'loan_recovery', false);
  listId = (
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'October',
      source: { type: 'manual' },
    })
  )._id.toString();
});

afterEach(() => setCampaignHooks({}));

let counter = 0;
const contact = async (over: Record<string, unknown> = {}) => {
  counter += 1;
  return ContactModel.create({
    accountId: t.account._id,
    phoneE164: phone(counter),
    name: `Customer ${String(counter)}`,
    source: { type: 'manual' },
    listIds: [new Types.ObjectId(listId)],
    variables: { amount: 1_500_000_000, due_date: '2026-10-10' },
    ...over,
  });
};
const listOf = async (...docs: { _id: Types.ObjectId }[]) => {
  const list = await ContactListModel.create({
    accountId: t.account._id,
    name: `L${String(Date.now())}${String(Math.random())}`,
    source: { type: 'manual' },
  });
  await ContactModel.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $addToSet: { listIds: list._id } },
  );
  return list._id.toString();
};
let named = 0;
const newCampaign = (over: Record<string, unknown> = {}) => {
  named += 1;
  return createCampaign(req, {
    name: `Campaign ${String(named)}`,
    mode: 'dry_run',
    flowId,
    ...over,
  } as never);
};
const docOf = async (id: string) =>
  (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;

describe('campaign lifecycle rules (pure)', () => {
  it('status moves and edit rules', () => {
    expect(canMoveCampaign('draft', 'running')).toBe(true);
    expect(canMoveCampaign('running', 'draft')).toBe(false);
    expect(canMoveCampaign('paused', 'scheduled')).toBe(true);
    expect(canMoveCampaign('completed', 'running')).toBe(false);
    expect(isFinalCampaign('canceled')).toBe(true);
    expect(isFinalCampaign('paused')).toBe(false);
    expect(editRule('draft')).toBe('all');
    expect(editRule('scheduled')).toBe('not_mode');
    expect(editRule('paused')).toBe('live');
    expect(editRule('failed')).toBe('none');
  });
});

describe('create / read / list', () => {
  it('a draft with defaults from the account; history; audit', async () => {
    const c = await newCampaign({ audience: { listIds: [listId] } });
    expect(c).toMatchObject({
      status: 'draft',
      mode: 'dry_run',
      flow: { id: flowId, name: 'Loan recovery', version: null },
      window: { start: '08:00', end: '20:00' },
      retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['no_answer', 'busy', 'failed'] },
      pacing: { concurrency: 5, dialsPerMinute: 30, priority: 'normal' },
      schedule: { timezone: 'Asia/Kolkata', startAt: null, recurrence: null },
      dryRun: { speed: 10 },
      revision: 1,
      createdBy: { id: owner.user._id.toString() },
      walletAvailableMicros: expect.any(Number),
    });
    expect(c.history).toHaveLength(1);
    expect(c.audience.listIds).toEqual([listId]);
    expect(
      await AuditLogModel.countDocuments({ action: 'campaign.created', 'target.id': c.id }),
    ).toBe(1);
    expect(await getCampaign(req, c.id)).toMatchObject({ id: c.id });
  });

  it('validation: window, pacing, schedule, dry run, fields, audience refs; live; names', async () => {
    const fails = async (over: Record<string, unknown>, path: string) => {
      const err = (await newCampaign(over).catch((e: unknown) => e)) as {
        code: string;
        details?: { path: string }[];
      };
      expect(err.code, path).toBe('VALIDATION_FAILED');
      expect(err.details?.map((d) => d.path)).toContain(path);
    };
    await fails({ window: { start: '21:00', end: '22:00', days: [1] } }, 'window');
    await fails({ pacing: { concurrency: 11 } }, 'pacing.concurrency');
    await fails({ pacing: { dialsPerMinute: 61 } }, 'pacing.dialsPerMinute');
    await fails({ retry: { retryOn: ['busy', 'busy'] } }, 'retry.retryOn');
    await fails(
      { schedule: { startAt: new Date(Date.now() + 100 * 86_400_000).toISOString() } },
      'schedule.startAt',
    );
    await fails(
      { schedule: { endAt: new Date(Date.now() - 1000).toISOString() } },
      'schedule.endAt',
    );
    await fails(
      { schedule: { recurrence: { freq: 'weekly', days: [], time: '10:00', until: null } } },
      'schedule.recurrence.days',
    );
    await fails(
      {
        schedule: {
          recurrence: { freq: 'daily', days: [], time: '10:00', until: '2020-01-01T00:00:00Z' },
        },
      },
      'schedule.recurrence.until',
    );
    await fails(
      { dryRun: { mix: { answered: 5000, no_answer: 0, busy: 0, failed: 0, invalid_number: 0 } } },
      'dryRun.mix',
    );
    await fails({ dryRun: { speed: 60 } }, 'dryRun.speed');
    await fails({ audience: { skipIfMissing: ['shoe_size'] } }, 'audience.skipIfMissing');
    await fails({ audience: { listIds: [new Types.ObjectId().toString()] } }, 'audience.listIds');
    await fails({ audience: { segmentId: new Types.ObjectId().toString() } }, 'audience.segmentId');
    await fails(
      { audience: { contactIds: [new Types.ObjectId().toString()] } },
      'audience.contactIds',
    );
    await fails({ flowId: new Types.ObjectId().toString() }, 'flowId');
    await fails({ flowId: draftFlowId }, 'flowId');
    await fails({ flowId: inboundFlowId }, 'flowId');
    await fails({ chosenVersion: 9 }, 'chosenVersion');
    await expect(newCampaign({ mode: 'live' })).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
    });
    await newCampaign({ name: 'Same Name' });
    await expect(newCampaign({ name: 'same name' })).rejects.toMatchObject({
      code: 'CONFLICT_DUPLICATE',
    });
  });

  it('list: filters, search, cursor pages, contact filter; other accounts → 404', async () => {
    const a = await newCampaign({ name: 'Zeta list' });
    const b = await newCampaign({ name: 'Zeta other' });
    const first = await listCampaigns(req, { limit: 1, q: 'zeta' });
    expect(first.items.map((i) => i.id)).toEqual([b.id]);
    expect(first.meta.hasMore).toBe(true);
    const second = await listCampaigns(req, {
      limit: 1,
      q: 'zeta',
      cursor: first.meta.nextCursor,
    } as never);
    expect(second.items.map((i) => i.id)).toEqual([a.id]);
    expect(second.meta).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      (
        await listCampaigns(req, {
          limit: 50,
          status: ['running'],
          mode: 'dry_run',
          flowId,
        } as never)
      ).items.every((i) => i.status === 'running'),
    ).toBe(true);
    expect(
      (await listCampaigns(req, { limit: 50, parentId: new Types.ObjectId().toString() })).items,
    ).toEqual([]);
    expect(
      (await listCampaigns(req, { limit: 50, contactId: new Types.ObjectId().toString() })).items,
    ).toEqual([]);
    const other = await createTestAccount();
    const otherReq = reqOf(other, await other.addUser('owner'));
    await expect(getCampaign(otherReq, a.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(getCampaign(req, 'nope')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await listCampaigns(otherReq, { limit: 50 })).items).toEqual([]);
  });
});

describe('update / duplicate / delete', () => {
  it('revision checks, merges, per-status rules, schedule hook', async () => {
    const scheduled = vi.fn(() => Promise.resolve());
    setCampaignHooks({ scheduled });
    const c = await newCampaign();
    const updated = await updateCampaign(req, c.id, {
      revision: 1,
      retry: { maxAttempts: 2 },
      followUps: { promiseCheck: { enabled: true } },
      dryRun: { speed: 20 },
    });
    expect(updated).toMatchObject({
      revision: 2,
      retry: { maxAttempts: 2, intervalMinutes: 60 },
      followUps: { callbacks: true, promiseCheck: { enabled: true, daysAfter: 1 } },
      dryRun: { speed: 20, mix: { answered: 6500 } },
    });
    await expect(updateCampaign(req, c.id, { revision: 1, name: 'x' })).rejects.toMatchObject({
      code: 'CAMPAIGN_REVISION_CONFLICT',
    });
    const reset = await updateCampaign(req, c.id, { revision: 2, dryRun: null });
    expect(reset.dryRun?.speed).toBe(10);
    const renamed = await newCampaign({ name: 'Taken name' });
    await expect(
      updateCampaign(req, c.id, { revision: 3, name: 'TAKEN NAME' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT_DUPLICATE',
    });
    void renamed;
    // scheduled: no mode change; a new start time moves the start job
    await CampaignModel.updateOne({ _id: c.id }, { status: 'scheduled' });
    await expect(
      updateCampaign(req, c.id, { revision: 3, mode: 'live' } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await updateCampaign(req, c.id, { revision: 3, schedule: { startAt: later } });
    expect(scheduled).toHaveBeenCalledTimes(1);
    // running: only the live-editable fields
    await CampaignModel.updateOne({ _id: c.id }, { status: 'running' });
    await expect(
      updateCampaign(req, c.id, {
        revision: 4,
        audience: { listIds: [] },
        schedule: { startAt: later },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const live = await updateCampaign(req, c.id, {
      revision: 4,
      name: 'Running rename',
      pacing: { concurrency: 2 },
      schedule: { endAt: new Date(Date.now() + 86_400_000).toISOString() },
      flowId,
    }).catch((e: unknown) => e);
    expect(live).toMatchObject({ code: 'VALIDATION_FAILED' }); // flowId is locked
    const ok = await updateCampaign(req, c.id, {
      revision: 4,
      name: 'Running rename',
      pacing: { concurrency: 2 },
      schedule: { endAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(ok).toMatchObject({ name: 'Running rename', pacing: { concurrency: 2 } });
    await CampaignModel.updateOne({ _id: c.id }, { status: 'completed' });
    await expect(updateCampaign(req, c.id, { revision: 5, name: 'x' })).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    // changing the flow / version is checked
    const d = await newCampaign();
    await expect(
      updateCampaign(req, d.id, { revision: 1, chosenVersion: 7 }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('duplicate names "(copy)", "(copy 2)"; delete only when it can no longer dial', async () => {
    const c = await newCampaign({ name: 'Original' });
    expect((await duplicateCampaign(req, c.id)).name).toBe('Original (copy)');
    const second = await duplicateCampaign(req, c.id);
    expect(second).toMatchObject({
      name: 'Original (copy 2)',
      status: 'draft',
      schedule: { startAt: null },
    });
    await deleteCampaign(req, second.id);
    await expect(getCampaign(req, second.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await CampaignModel.updateOne({ _id: c.id }, { status: 'paused' });
    await expect(deleteCampaign(req, c.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
  });
});

describe('audience preview and snapshot', () => {
  it('classifies rows: first failing reason wins; the same phone twice is a duplicate', () => {
    const ctx = {
      seenPhones: new Set<string>(),
      activeContactIds: new Set<string>(),
      used: [{ name: 'amount', label: 'Amount', type: 'currency' as const }],
      skipIfMissing: new Set<string>(),
    };
    const row = (over: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      phoneE164: '+919000699001',
      variables: { amount: 1 },
      ...over,
    });
    expect(classifyRow(row(), ctx)).toEqual({ skip: null, missing: [] });
    expect(classifyRow(row(), ctx).skip).toBe('duplicate_phone');
    expect(classifyRow(row({ phoneE164: '12345' }), ctx).skip).toBe('invalid_phone');
    expect(classifyRow(row({ dnd: true, optedOutAt: new Date() }), ctx).skip).toBe('dnd');
    expect(classifyRow(row({ phoneE164: '+919000699002', variables: {} }), ctx)).toEqual({
      skip: null,
      missing: ['amount'],
    });
  });

  it('counts every exclusion, empty fields and samples (names + last 4)', async () => {
    const ok = await contact();
    const dnd = await contact({ dnd: true });
    const out = await contact({ optedOutAt: new Date() });
    const empty = await contact({ variables: {} });
    const busy = await contact();
    const list = await listOf(ok, dnd, out, empty, busy);
    // `busy` waits in another running campaign
    const other = await CampaignModel.create({
      ...(await docOf((await newCampaign()).id)),
      _id: new Types.ObjectId(),
      name: 'Other running',
      status: 'running',
    });
    await CampaignContactModel.create({
      accountId: t.account._id,
      campaignId: other._id,
      contactId: busy._id,
      seq: 1,
      phoneE164: busy.phoneE164,
    });
    const preview = await previewCampaignAudience(req, {
      flowId,
      audience: { listIds: [list], skipIfMissing: ['amount'] },
    });
    expect(preview).toMatchObject({
      total: 5,
      willCall: 1,
      tooMany: false,
      excluded: {
        dnd: 1,
        opted_out: 1,
        invalid_phone: 0,
        duplicate_phone: 0,
        in_active_campaign: 1,
        missing_values: 1,
      },
      missing: [
        { field: 'amount', label: 'Amount', count: 1 },
        { field: 'due_date', label: 'Due date', count: 1 },
      ],
    });
    expect(preview.samples).toEqual([{ name: ok.name, phoneLast4: ok.phoneE164.slice(-4) }]);
    const keep = await previewCampaignAudience(req, {
      flowId,
      audience: { listIds: [list], excludeActiveCampaigns: false },
    });
    expect(keep.willCall).toBe(3); // busy + empty come back
    expect(await previewCampaignAudience(req, { flowId, audience: {} })).toMatchObject({
      total: 0,
      willCall: 0,
    });
    await expect(
      previewCampaignAudience(req, {
        flowId,
        audience: { listIds: [new Types.ObjectId().toString()] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('segments, filters and picked contacts are a union; the fields used by the flow', async () => {
    const a = await contact({ tags: ['vip'], listIds: [] });
    await contact({ listIds: [], tags: ['bee'] });
    const segment = await SegmentModel.create({
      accountId: t.account._id,
      name: 'VIP',
      filter: { tags: { mode: 'any', values: ['vip'] } },
      createdBy: owner.user._id,
    });
    const preview = await previewCampaignAudience(req, {
      flowId,
      audience: {
        segmentId: segment._id.toString(),
        filter: { tags: { mode: 'any', values: ['bee'] } },
        contactIds: [a._id.toString()],
      },
    } as never);
    expect(preview.total).toBe(2);
    const fields = await usedFields(t.account._id, { texts: '{{amount}} {{contact.phone}}' }, []);
    expect(fields.map((f) => f.name)).toEqual(['name', 'amount']);
    const agentFields = await usedFields(t.account._id, {}, [new Types.ObjectId(agentId)]);
    expect(agentFields.map((f) => f.name)).toContain('name');
  });

  it('snapshot: pending + skipped rows with display values; resumes without duplicates; 3 000 in batches', async () => {
    const people = await ContactModel.insertMany(
      Array.from({ length: 3_000 }, (_, i) => ({
        accountId: t.account._id,
        phoneE164: `+9190007${String(i).padStart(5, '0')}`,
        name: `Bulk ${String(i)}`,
        source: { type: 'manual' },
        searchText: '',
        variables: { amount: 1_000_000_000 + i },
      })),
    );
    const list = await listOf(...people);
    await DndEntryModel.create({
      accountId: t.account._id,
      phoneE164: people[5]?.phoneE164,
      source: 'manual',
    });
    await ContactModel.updateOne({ _id: people[5]?._id }, { dnd: true });
    const c = await newCampaign({ audience: { listIds: [list] } });
    const doc = await docOf(c.id);
    const used = [
      { name: 'name', label: 'Name', type: 'built_in' as const },
      { name: 'amount', label: 'Amount', type: 'currency' as const },
    ];
    // a crash after the first batch: rows exist, the cursor points at the last one
    await takeSnapshot({ ...doc, audience: { ...doc.audience } }, used, new Date());
    const before = await CampaignContactModel.countDocuments({ campaignId: doc._id });
    await CampaignContactModel.deleteMany({ campaignId: doc._id, seq: { $gt: 1_000 } });
    const cursor = (
      await CampaignContactModel.findOne({ campaignId: doc._id }).sort({ seq: -1 }).lean()
    )?.contactId.toString();
    await CampaignModel.updateOne(
      { _id: doc._id },
      { 'snapshot.cursor': cursor, 'snapshot.done': false },
    );
    const counts = await takeSnapshot(await docOf(c.id), used, new Date());
    expect(before).toBe(3_000);
    expect(counts).toMatchObject({ total: 3_000, byStat: { pending: 2_999, skipped: 1 } });
    expect(counts.skippedBy.dnd).toBe(1);
    expect(await CampaignContactModel.countDocuments({ campaignId: doc._id })).toBe(3_000);
    const row = await CampaignContactModel.findOne({
      campaignId: doc._id,
      contactId: people[0]?._id,
    }).lean();
    expect(row).toMatchObject({
      status: 'pending',
      dueRank: 2,
      name: 'Bulk 0',
      variables: { name: 'Bulk 0', amount: '₹1,000.00' },
    });
    expect((await docOf(c.id)).stats).toMatchObject({ total: 3_000, pending: 2_999, skipped: 1 });
  });
});

describe('start / pause / resume / cancel', () => {
  it('start now: pinned version, snapshot, running, hook; nobody to call → completed', async () => {
    const running = vi.fn(() => Promise.resolve());
    setCampaignHooks({ running });
    const p1 = await contact();
    const list = await listOf(p1, await contact());
    const c = await newCampaign({ audience: { listIds: [list] } });
    const started = await startCampaign(req, c.id);
    expect(started).toMatchObject({
      status: 'running',
      flow: { version: 1 },
      stats: { total: 2, pending: 2 },
      startedBy: { id: owner.user._id.toString() },
    });
    expect(started.history.map((h) => h.status)).toEqual(['draft', 'running']);
    expect(running).toHaveBeenCalledTimes(1);
    expect(await isFlowInUse(flowId)).toBe(true);
    expect(
      await AuditLogModel.countDocuments({ action: 'campaign.started', 'target.id': c.id }),
    ).toBe(1);
    await expect(startCampaign(req, c.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });

    const everyoneDnd = await contact({ dnd: true });
    const empty = await newCampaign({ audience: { listIds: [await listOf(everyoneDnd)] } });
    expect(await startCampaign(req, empty.id)).toMatchObject({
      status: 'completed',
      stats: { skipped: 1 },
    });
  });

  it('later or recurring → scheduled (hook); refusals: no audience, agent off, limit, suspended, live', async () => {
    const scheduled = vi.fn(() => Promise.resolve());
    setCampaignHooks({ scheduled });
    const list = await listOf(await contact());
    const later = await newCampaign({
      audience: { listIds: [list] },
      schedule: { startAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(await startCampaign(req, later.id)).toMatchObject({ status: 'scheduled' });
    const recurring = await newCampaign({
      audience: { listIds: [list] },
      schedule: { recurrence: { freq: 'daily', days: [], time: '10:00', until: null } },
    });
    expect(await startCampaign(req, recurring.id)).toMatchObject({
      status: 'scheduled',
      recurring: true,
    });
    expect(scheduled).toHaveBeenCalledTimes(2);
    expect(
      await AuditLogModel.countDocuments({ action: 'campaign.scheduled', 'target.id': later.id }),
    ).toBe(1);

    const nobody = await newCampaign();
    await expect(startCampaign(req, nobody.id)).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
    });

    await AiAgentModel.updateOne({ _id: agentId }, { isActive: false });
    const off = await newCampaign({ audience: { listIds: [list] } });
    await expect(startCampaign(req, off.id)).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
      details: [{ path: 'flow.agents', message: 'AI agent "Recovery" is turned off' }],
    });
    await AiAgentModel.updateOne({ _id: agentId }, { isActive: true });

    await CampaignModel.updateOne({ _id: off.id }, { mode: 'live' });
    await expect(startCampaign(req, off.id)).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
    });
    await CampaignModel.updateOne({ _id: off.id }, { mode: 'dry_run' });

    await AccountModel.updateOne({ _id: t.account._id }, { status: 'suspended' });
    await expect(startCampaign(req, off.id)).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
    });
    await AccountModel.updateOne({ _id: t.account._id }, { status: 'active' });

    const active = await CampaignModel.countDocuments({
      accountId: t.account._id,
      status: { $in: ['scheduled', 'running', 'paused'] },
    });
    const fillers = Array.from({ length: Math.max(0, 10 - active) }, (_, i) => ({
      accountId: t.account._id,
      name: `Filler ${String(i)}`,
      flowId: new Types.ObjectId(),
      schedule: { timezone: 'Asia/Kolkata' },
      window: { start: '09:00', end: '19:00', days: [1] },
      retry: { maxAttempts: 1, intervalMinutes: 15 },
      pacing: { concurrency: 1, dialsPerMinute: 1 },
      status: 'paused',
    }));
    const inserted = await CampaignModel.insertMany(fillers);
    await expect(startCampaign(req, off.id)).rejects.toMatchObject({
      code: 'CAMPAIGN_LIMIT_REACHED',
    });
    await CampaignModel.deleteMany({ _id: { $in: inserted.map((d) => d._id) } });
  });

  it('pause / resume (blocked while the cause holds) / unschedule / cancel', async () => {
    const running = vi.fn(() => Promise.resolve());
    const scheduled = vi.fn(() => Promise.resolve());
    const unscheduled = vi.fn(() => Promise.resolve());
    const hangUpLive = vi.fn(() => Promise.resolve());
    let blocker: string | null = 'Add money to resume';
    setCampaignHooks({
      running,
      scheduled,
      unscheduled,
      hangUpLive,
      resumeBlocker: () => Promise.resolve(blocker),
    });
    const list = await listOf(await contact(), await contact(), await contact());
    const c = await newCampaign({ audience: { listIds: [list] } });
    await startCampaign(req, c.id);
    const paused = await pauseCampaign(req, c.id);
    expect(paused).toMatchObject({
      status: 'paused',
      pauseReason: 'manual',
      pausedAt: expect.any(String),
    });
    await expect(pauseCampaign(req, c.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    await expect(resumeCampaign(req, c.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
      message: 'Add money to resume',
    });
    blocker = null;
    expect(await resumeCampaign(req, c.id)).toMatchObject({ status: 'running', pauseReason: null });
    await expect(resumeCampaign(req, c.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    // an admin pause is only lifted by the platform team; suspended accounts can't resume
    const admin = await setStatus(await docOf(c.id), 'paused', { pauseReason: 'admin' });
    await expect(resumeCampaign(req, admin._id.toString())).rejects.toMatchObject({
      message: 'Paused by the platform team — only they can resume it.',
    });
    await CampaignModel.updateOne({ _id: c.id }, { pauseReason: 'manual' });
    await AccountModel.updateOne({ _id: t.account._id }, { status: 'suspended' });
    await expect(resumeCampaign(req, c.id)).rejects.toMatchObject({
      message: 'The account is suspended.',
    });
    await AccountModel.updateOne({ _id: t.account._id }, { status: 'active' });
    // cancel: waiting contacts → canceled, live calls hung up on request
    await CampaignContactModel.updateOne({ campaignId: c.id, seq: 1 }, { status: 'completed' });
    const canceled = await cancelCampaign(req, c.id, true);
    expect(canceled).toMatchObject({ status: 'canceled', stats: { pending: 0, canceled: 2 } });
    expect(hangUpLive).toHaveBeenCalledTimes(1);
    await expect(cancelCampaign(req, c.id, false)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });

    // a scheduled campaign: pause → resume goes back to scheduled; unschedule → draft
    const later = await newCampaign({
      audience: { listIds: [list] },
      schedule: { startAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await startCampaign(req, later.id);
    await pauseCampaign(req, later.id);
    expect(await resumeCampaign(req, later.id)).toMatchObject({ status: 'scheduled' });
    expect(await unscheduleCampaign(req, later.id)).toMatchObject({ status: 'draft' });
    await expect(unscheduleCampaign(req, later.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    expect(unscheduled).toHaveBeenCalledTimes(2);
    // a status that changed meanwhile → 409
    const stale = await docOf(later.id);
    await CampaignModel.updateOne({ _id: later.id }, { status: 'canceled' });
    await expect(setStatus(stale, 'running')).rejects.toMatchObject({
      message: 'The campaign changed meanwhile — reload it.',
    });
    await expect(cancelCampaign(req, later.id, false)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
  });

  it('beginRun refuses a version that can no longer run; contacts of a campaign are listed by seq', async () => {
    const list = await listOf(await contact(), await contact());
    const c = await newCampaign({ audience: { listIds: [list] } });
    await AiAgentModel.updateOne({ _id: agentId }, { deletedAt: new Date() });
    await expect(beginRun(await docOf(c.id), null)).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
      details: [{ path: 'flow.agents', message: 'An AI agent of this flow was deleted' }],
    });
    await AiAgentModel.collection.updateOne(
      { _id: new Types.ObjectId(agentId) },
      { $set: { deletedAt: null } },
    );
    await startCampaign(req, c.id);
    const page = await listCampaignContacts(req, c.id, { limit: 1 });
    expect(page.items[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      phoneLast4: expect.any(String),
    });
    expect(page.items[0]).not.toHaveProperty('phoneE164');
    const next = await listCampaignContacts(req, c.id, {
      limit: 1,
      cursor: page.meta.nextCursor,
    } as never);
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    expect(next.meta.hasMore).toBe(false);
    const filtered = await listCampaignContacts(req, c.id, {
      limit: 10,
      status: ['completed'],
      lastResult: 'busy',
      disposition: 'paid',
      skipReason: 'dnd',
      q: 'x',
    } as never);
    expect(filtered.items).toEqual([]);
  });
});

describe('estimate', () => {
  it('contacts × expected attempts, the flow average duration, ±25 %', async () => {
    expect(expectedAttemptsBps({ maxAttempts: 3, intervalMinutes: 60, retryOn: ['busy'] })).toBe(
      18_000,
    );
    expect(expectedAttemptsBps({ maxAttempts: 3, intervalMinutes: 60, retryOn: ['failed'] })).toBe(
      10_000,
    );
    expect(await averageDurationSec(t.account._id, new Types.ObjectId(flowId))).toBe(60);
    await CallModel.create({
      accountId: t.account._id,
      direction: 'outbound',
      provider: 'sip',
      from: 'x',
      to: '+919000000001',
      isTest: false,
      status: 'completed',
      durationSec: 91,
      source: { kind: 'flow', flowId: new Types.ObjectId(flowId) },
      timestamps: { queuedAt: new Date() },
    });
    expect(await averageDurationSec(t.account._id, new Types.ObjectId(flowId))).toBe(91);
    const list = await listOf(await contact(), await contact(), await contact(), await contact());
    const c = await newCampaign({ audience: { listIds: [list] } });
    const est = await estimateCampaignCost(req, c.id);
    expect(est).toMatchObject({
      contacts: 4,
      calls: 8, // 4 × 1.8 rounded up
      assumptions: {
        avgDurationSec: 91,
        answerRateBps: 6000,
        aiShareBps: 5000,
        expectedAttempts: 1.8,
      },
    });
    expect(est.minMicros).toBeLessThan(est.totalMicros);
    expect(est.maxMicros).toBeGreaterThan(est.totalMicros);
    expect((await docOf(c.id)).estimate?.totalMicros).toBe(est.totalMicros);
    await startCampaign(req, c.id);
    expect((await estimateCampaignCost(req, c.id)).contacts).toBe(4); // from the snapshot now
  });
});

describe('flows in use', () => {
  it('a flow with an active campaign cannot be deleted (409 names the campaigns)', async () => {
    const list = await listOf(await contact());
    const c = await newCampaign({ name: 'Blocks delete', audience: { listIds: [list] } });
    await startCampaign(req, c.id);
    const res = await request(app).delete(`${FLOWS}/${flowId}`).set(auth(owner));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_IN_USE');
    expect(res.body.error.details).toContainEqual({
      path: 'campaigns',
      message: 'Blocks delete',
      id: c.id,
    });
    expect(await isFlowInUse('nope')).toBe(false);
    expect(await FlowModel.countDocuments({ _id: flowId })).toBe(1);
  });
});
