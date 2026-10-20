import { Writable } from 'node:stream';

import type { Request } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { AccountModel } from '../../src/db/models/account.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import {
  cancelCampaign,
  createCampaign,
  listCampaignRuns,
  pauseCampaign,
  pauseCampaignDoc,
  resumeCampaign,
  setCampaignHooks,
  setStatus,
  startCampaign,
  unscheduleCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { campaignRecipients } from '../../src/modules/campaigns/notifications';
import { dueParents, runDue } from '../../src/modules/campaigns/runs';
import { sweepCampaigns } from '../../src/modules/campaigns/sweep';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { FLOWS, auth } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const emails = useCapturedEmail();
const app = buildTestApp({}, { storage, aiProvider: createFakeProvider() });
const logLines: string[] = [];
const logger = createLogger(
  { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
);

let t: TestAccount;
let owner: TestUser;
let admin: TestUser;
let manager: TestUser;
let flowId: string;
let listId: string;

const reqOf = (user: TestUser): Request =>
  ({
    auth: {
      kind: 'user',
      accountId: t.account._id.toString(),
      userId: user.user._id.toString(),
      roleKey: user.roleKey,
      permissions: new Set<string>(),
      account: {
        id: t.account._id.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  }) as unknown as Request;

beforeAll(async () => {
  await ensureRateCard();
  t = await createTestAccount({ name: 'Runs Co' });
  owner = await t.addUser('owner');
  admin = await t.addUser('admin');
  manager = await t.addUser('manager');
  await t.addUser('viewer');
  await AccountModel.updateOne(
    { _id: t.account._id },
    { 'settings.callingWindow': { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  );
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'amount',
    label: 'Amount',
    type: 'currency',
  });
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(owner))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  const created = await request(app)
    .post(FLOWS)
    .set(auth(owner))
    .send({
      name: 'Loan recovery',
      templateKey: 'loan_recovery',
      agentIds: { ai: agent.body.data.id },
    });
  flowId = created.body.data.id;
  const published = await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: created.body.data.revision });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  listId = (
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'Runs list',
      source: { type: 'manual' },
    })
  )._id.toString();
  for (let i = 1; i <= 3; i += 1) {
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: `+9190005${String(i).padStart(5, '0')}`,
      name: `Runner ${String(i)}`,
      source: { type: 'manual' },
      listIds: [new Types.ObjectId(listId)],
      variables: { amount: 1_000_000_000 },
    });
  }
});
afterEach(() => setCampaignHooks({}));

const docOf = async (id: string) =>
  (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;

let n = 0;
const recurring = async (over: Record<string, unknown> = {}) => {
  n += 1;
  const c = await createCampaign(reqOf(manager), {
    name: `Daily reminder ${String(n)}`,
    mode: 'dry_run',
    flowId,
    audience: { listIds: [listId], excludeActiveCampaigns: false },
    schedule: { recurrence: { freq: 'daily', days: [], time: '10:00', until: null } },
    ...over,
  } as never);
  return c.id;
};

describe('recurring runs (PHASE_8_PLAN §1g)', () => {
  it('a parent is scheduled with its next run; each occurrence creates one run; the CAS stops doubles', async () => {
    const id = await recurring();
    const started = await startCampaign(reqOf(manager), id);
    expect(started.status).toBe('scheduled');
    const parent = await docOf(id);
    expect(parent.nextRunAt).toBeInstanceOf(Date);
    expect(parent.flowVersion).toBe(1); // pinned at scheduling
    expect(started.nextRunAt).toBe(parent.nextRunAt?.toISOString());
    const due = parent.nextRunAt as Date;
    expect(await runDue(id, new Date(due.getTime() - 60_000), logger)).toBe('not_due');
    expect(await runDue(id, due, logger)).toBe('created');
    // a second job / the sweep for the same occurrence does nothing
    expect(await runDue(id, due, logger)).toBe('not_due');
    const runs = await CampaignModel.find({ parentId: id }).lean<CampaignDoc[]>();
    expect(runs).toHaveLength(1);
    const run = runs[0] as CampaignDoc;
    expect(run).toMatchObject({
      runNumber: 1,
      status: 'running',
      chosenVersion: 1,
      flowVersion: 1,
      schedule: { recurrence: null },
    });
    expect(run.name).toMatch(/^Daily reminder 1 · \d{1,2} [A-Z][a-z]{2}$/);
    expect(run.stats.total).toBe(3);
    const next = (await docOf(id)).nextRunAt as Date;
    expect(next.getTime() - due.getTime()).toBe(24 * 3600_000);
    expect((await listCampaignRuns(reqOf(manager), id)).items.map((r) => r.runNumber)).toEqual([1]);
  });

  it('skips while the previous run is active (+ notification), runs again after it ends', async () => {
    const id = await recurring();
    await startCampaign(reqOf(manager), id);
    const first = (await docOf(id)).nextRunAt as Date;
    expect(await runDue(id, first, logger)).toBe('created');
    const second = (await docOf(id)).nextRunAt as Date;
    expect(await runDue(id, second, logger)).toBe('skipped');
    const skipped = await NotificationModel.find({ type: 'campaign.run_skipped' }).lean();
    expect(skipped.map((s) => s.userId.toString()).sort()).toEqual(
      [owner, admin, manager].map((u) => u.user._id.toString()).sort(),
    );
    expect(skipped[0]).toMatchObject({
      body: expect.stringContaining('skipped — the previous run is still active'),
      link: `/campaigns/${id}`,
    });
    const run = (await CampaignModel.findOne({ parentId: id }).lean<CampaignDoc>()) as CampaignDoc;
    await setStatus(run, 'completed', { set: { completedAt: new Date() } });
    const third = (await docOf(id)).nextRunAt as Date;
    expect(await runDue(id, third, logger)).toBe('created');
    expect((await CampaignModel.find({ parentId: id }).lean()).map((r) => r.runNumber)).toEqual(
      expect.arrayContaining([1, 2]),
    );
  });

  it('missed occurrences are not made up; "latest" runs take the then-latest version', async () => {
    const id = await recurring({ versionPolicy: 'latest' });
    await startCampaign(reqOf(manager), id);
    const due = (await docOf(id)).nextRunAt as Date;
    const late = new Date(due.getTime() + 3 * 24 * 3600_000 + 60_000); // 3 days down
    expect(await runDue(id, late, logger)).toBe('created');
    const run = await CampaignModel.findOne({ parentId: id }).lean<CampaignDoc>();
    expect(run?.chosenVersion).toBeNull();
    expect(run?.flowVersion).toBe(1);
    expect(((await docOf(id)).nextRunAt as Date).getTime()).toBeGreaterThan(late.getTime());
  });

  it('until: the parent completes after its last occurrence', async () => {
    const id = await recurring();
    await startCampaign(reqOf(manager), id);
    const due = (await docOf(id)).nextRunAt as Date;
    await CampaignModel.updateOne({ _id: id }, { 'schedule.recurrence.until': due });
    expect(await runDue(id, due, logger)).toBe('created');
    const parent = await docOf(id);
    expect(parent).toMatchObject({ status: 'completed', nextRunAt: null });
    // a recurring parent's completion is not announced (its runs are)
    expect(
      await NotificationModel.countDocuments({
        type: 'campaign.completed',
        link: `/campaigns/${id}`,
      }),
    ).toBe(0);
  });

  it('paused / canceled / unscheduled parents create no runs; resume continues from now', async () => {
    const id = await recurring();
    await startCampaign(reqOf(manager), id);
    const due = (await docOf(id)).nextRunAt as Date;
    await pauseCampaign(reqOf(manager), id);
    expect(await runDue(id, due, logger)).toBe('not_due');
    await resumeCampaign(reqOf(manager), id);
    const resumed = await docOf(id);
    expect(resumed.status).toBe('scheduled');
    expect(resumed.nextRunAt).toBeInstanceOf(Date);
    await unscheduleCampaign(reqOf(manager), id);
    expect((await docOf(id)).nextRunAt).toBeNull();
    expect(await runDue(id, due, logger)).toBe('not_due');
    await startCampaign(reqOf(manager), id);
    await cancelCampaign(reqOf(manager), id, false);
    expect((await docOf(id)).nextRunAt).toBeNull();
    expect(await runDue(new Types.ObjectId(), due, logger)).toBe('not_due');
  });

  it('a run that cannot start ends failed; the sweep runs due parents', async () => {
    const id = await recurring();
    await startCampaign(reqOf(manager), id);
    const due = (await docOf(id)).nextRunAt as Date;
    await FlowModel.updateOne({ _id: flowId }, { $set: { deletedAt: new Date() } });
    try {
      expect(await runDue(id, due, logger)).toBe('failed');
      const run = await CampaignModel.findOne({ parentId: id }).lean<CampaignDoc>();
      expect(run).toMatchObject({ status: 'failed', error: { code: 'CAMPAIGN_NOT_RUNNABLE' } });
    } finally {
      // the soft-delete plugin hides deleted flows from model queries
      await FlowModel.collection.updateOne(
        { _id: new Types.ObjectId(flowId) },
        { $set: { deletedAt: null } },
      );
    }
    // lost scheduler job: the sweep finds the parent by nextRunAt
    const next = (await docOf(id)).nextRunAt as Date;
    expect((await dueParents(next)).map(String)).toContain(id);
    const dispatcher = { wake: () => undefined, ensureAccount: () => undefined } as never;
    const result = await sweepCampaigns({ dispatcher, logger, now: next });
    expect(result.runs).toBeGreaterThanOrEqual(1);
    expect(await CampaignModel.countDocuments({ parentId: id })).toBe(2);
  });
});

describe('campaign notifications (PHASE_8_PROMPT §1 "Notifications")', () => {
  const oneShot = async () => {
    n += 1;
    const c = await createCampaign(reqOf(manager), {
      name: `One shot ${String(n)}`,
      mode: 'dry_run',
      flowId,
      audience: { listIds: [listId], excludeActiveCampaigns: false },
    } as never);
    await startCampaign(reqOf(manager), c.id);
    return c.id;
  };

  it('recipients: the starter + owners + admins, active only, deduped', async () => {
    const id = await oneShot();
    const users = (await campaignRecipients(await docOf(id))).map((r) => r.userId.toString());
    expect(users.sort()).toEqual([owner, admin, manager].map((u) => u.user._id.toString()).sort());
  });

  it('an automatic pause: in-app for everyone + one email per person per pause', async () => {
    const id = await oneShot();
    emails.length = 0;
    const paused = await pauseCampaignDoc(await docOf(id), 'wallet_empty', null);
    const rows = await NotificationModel.find({
      type: 'campaign.paused',
      link: `/campaigns/${id}`,
    }).lean();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.body).toBe(`Campaign "${paused.name}" paused: the wallet balance ran out.`);
    const mails = emails.filter((e) => e.template === 'campaign.paused');
    expect(mails.map((m) => m.to).sort()).toEqual(
      [owner, admin, manager].map((u) => u.user.email).sort(),
    );
    expect(mails[0]?.vars).toMatchObject({
      campaignName: paused.name,
      reason: 'the wallet balance ran out',
      dryRun: true,
      campaignUrl: expect.stringMatching(new RegExp(`/campaigns/${id}$`)),
    });
    // the dedupe key is per campaign + pause + person: a retry of the same pause sends nothing new
    expect(new Set(mails.map((m) => m.dedupeKey)).size).toBe(3);
    expect(mails.every((m) => m.dedupeKey?.includes(String(paused.pausedAt?.getTime())))).toBe(
      true,
    );
    // no phones or contact names in the mail variables
    expect(JSON.stringify(mails)).not.toMatch(/\+91|Runner/);
  });

  it('a manual pause: in-app for the others, no email; completion tells the counts', async () => {
    const id = await oneShot();
    emails.length = 0;
    await pauseCampaign(reqOf(manager), id);
    const rows = await NotificationModel.find({
      type: 'campaign.paused',
      link: `/campaigns/${id}`,
    }).lean();
    expect(rows.map((r) => r.userId.toString()).sort()).toEqual(
      [owner, admin].map((u) => u.user._id.toString()).sort(),
    );
    expect(rows[0]?.body).toContain('paused by a team member');
    expect(emails.filter((e) => e.template === 'campaign.paused')).toHaveLength(0);
    await CampaignModel.updateOne({ _id: id }, { 'stats.completed': 2, 'stats.failed': 1 });
    await setStatus(await docOf(id), 'completed', { set: { completedAt: new Date() } });
    const done = await NotificationModel.findOne({
      type: 'campaign.completed',
      link: `/campaigns/${id}`,
    }).lean();
    expect(done?.body).toMatch(/finished — 2 completed, 1 not reached\.$/);
  });
});

describe('contact filters on the call history (T8.6)', () => {
  it('lastDisposition / lastCalledAt filter contacts and segments; the JSON shows them', async () => {
    const [a, b] = await ContactModel.find({ accountId: t.account._id, listIds: listId })
      .sort({ _id: 1 })
      .limit(2)
      .lean();
    await ContactModel.updateOne(
      { _id: a?._id },
      {
        lastDisposition: 'paid',
        lastCalledAt: new Date(Date.now() - 2 * 24 * 3600_000),
        callCount: 1,
      },
    );
    await ContactModel.updateOne(
      { _id: b?._id },
      {
        lastDisposition: 'promise_to_pay',
        lastCalledAt: new Date(Date.now() - 20 * 24 * 3600_000),
        callCount: 2,
      },
    );
    const search = (conditions: object[]) =>
      request(app)
        .post('/api/v1/segments/preview')
        .set(auth(owner))
        .send({ filter: { listIds: [listId], conditions } });
    const paid = await search([{ key: 'lastDisposition', op: 'eq', value: 'paid' }]);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.count).toBe(1);
    const never = await search([{ key: 'lastCalledAt', op: 'not_exists' }]);
    expect(never.body.data.count).toBe(1);
    const recent = await search([{ key: 'lastCalledAt', op: 'within_last_days', value: 7 }]);
    expect(recent.body.data.count).toBe(1);
    const bad = await search([{ key: 'lastDisposition', op: 'eq', value: 'happy' }]);
    expect(bad.status).toBe(422);
    const detail = await request(app)
      .get(`/api/v1/contacts/${String(a?._id)}`)
      .set(auth(owner));
    expect(detail.body.data).toMatchObject({ lastDisposition: 'paid', callCount: 1 });
  });
});
