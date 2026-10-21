import type { Request } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { callingWindowWarning } from '../../src/modules/account/account.service';
import {
  createCampaign,
  resumeCampaign,
  startCampaign,
  startScheduled,
} from '../../src/modules/campaigns/campaigns.service';
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
useCapturedEmail();
const app = buildTestApp({}, { storage, aiProvider: createFakeProvider() });

let platform: TestAccount;
let superadmin: TestUser;
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
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-${String(Date.now())}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  t = await createTestAccount({ name: 'Limits Co' });
  owner = await t.addUser('owner');
  admin = await t.addUser('admin');
  manager = await t.addUser('manager');
  await AccountModel.updateOne(
    { _id: t.account._id },
    { 'settings.callingWindow': { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  );
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
  await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: created.body.data.revision });
  listId = (
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'Limits list',
      source: { type: 'manual' },
    })
  )._id.toString();
  await ContactModel.create({
    accountId: t.account._id,
    phoneE164: '+919000400001',
    name: 'Limit One',
    source: { type: 'manual' },
    listIds: [new Types.ObjectId(listId)],
    variables: { amount: 1_000_000_000 },
  });
});

const ADMIN = '/api/v1/admin/accounts';
let n = 0;
const campaign = async (start: 'now' | 'later' | null) => {
  n += 1;
  const c = await createCampaign(reqOf(manager), {
    name: `Limits ${String(n)}`,
    mode: 'dry_run',
    flowId,
    audience: { listIds: [listId], excludeActiveCampaigns: false },
    ...(start === 'later'
      ? { schedule: { startAt: new Date(Date.now() + 24 * 3600_000).toISOString() } }
      : {}),
  } as never);
  if (start) await startCampaign(reqOf(manager), c.id);
  return c.id;
};
const docOf = async (id: string) =>
  (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;

describe('admin limits + emergency pause (T8.6)', () => {
  it('PATCH limits: superadmin only, ranges checked, audited on both sides, shown in the detail', async () => {
    const url = `${ADMIN}/${t.account._id.toString()}/limits`;
    expect(
      (await request(app).patch(url).set(auth(owner)).send({ dialsPerMinute: 5 })).status,
    ).toBe(403);
    expect(
      (await request(app).patch(url).set(auth(superadmin)).send({ maxConcurrentCalls: 201 }))
        .status,
    ).toBe(422);
    expect((await request(app).patch(url).set(auth(superadmin)).send({})).status).toBe(422);
    const res = await request(app)
      .patch(url)
      .set(auth(superadmin))
      .send({ maxConcurrentCalls: 25, dialsPerMinute: 120 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ maxConcurrentCalls: 25, dialsPerMinute: 120 });
    const audits = await AuditLogModel.find({ action: 'account.limits_updated' }).lean();
    expect(audits.map((a) => a.accountId.toString()).sort()).toEqual(
      [t.account._id.toString(), platform.account._id.toString()].sort(),
    );
    expect(audits[0]?.meta).toEqual({ fields: ['maxConcurrentCalls', 'dialsPerMinute'] });
    const detail = await request(app)
      .get(`${ADMIN}/${t.account._id.toString()}`)
      .set(auth(superadmin));
    expect(detail.body.data.limits).toEqual({ maxConcurrentCalls: 25, dialsPerMinute: 120 });
    expect(detail.body.data.activeCampaigns).toEqual(expect.any(Number));
  });

  it('emergency pause: running + scheduled pause as admin; only a superadmin resumes them', async () => {
    const running = await campaign('now');
    const scheduled = await campaign('later');
    const draft = await campaign(null);
    const before = (
      await request(app).get(`${ADMIN}/${t.account._id.toString()}`).set(auth(superadmin))
    ).body.data.activeCampaigns as number;
    expect(before).toBeGreaterThanOrEqual(2);
    const url = `${ADMIN}/${t.account._id.toString()}/campaigns/pause`;
    expect((await request(app).post(url).set(auth(owner))).status).toBe(403);
    const res = await request(app).post(url).set(auth(superadmin));
    expect(res.status).toBe(200);
    expect(res.body.data.paused).toBeGreaterThanOrEqual(2);
    for (const id of [running, scheduled]) {
      expect(await docOf(id)).toMatchObject({ status: 'paused', pauseReason: 'admin' });
    }
    expect((await docOf(draft)).status).toBe('draft');
    // the account detail lists what only a superadmin can resume
    const paused = (
      await request(app).get(`${ADMIN}/${t.account._id.toString()}`).set(auth(superadmin))
    ).body.data.adminPausedCampaigns as { id: string; name: string }[];
    expect(paused.map((c) => c.id).sort()).toEqual([running, scheduled].sort());
    expect(paused[0]?.name).toEqual(expect.any(String));
    expect(
      await AuditLogModel.countDocuments({
        action: 'campaign.admin_paused',
        accountId: t.account._id,
      }),
    ).toBe(1);
    // the account's own users can't lift it
    await expect(resumeCampaign(reqOf(owner), running)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    const resume = (id: string) =>
      request(app)
        .post(`${ADMIN}/${t.account._id.toString()}/campaigns/${id}/resume`)
        .set(auth(superadmin));
    const lifted = await resume(running);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(lifted.body.data).toEqual({ id: running, status: 'running' });
    expect((await resume(scheduled)).body.data.status).toBe('scheduled');
    expect(
      (await request(app).get(`${ADMIN}/${t.account._id.toString()}`).set(auth(superadmin))).body
        .data.adminPausedCampaigns,
    ).toEqual([]);
    expect((await resume(draft)).status).toBe(409);
    expect((await resume(new Types.ObjectId().toString())).status).toBe(404);
    expect(
      (
        await request(app)
          .post(`${ADMIN}/${t.account._id.toString()}/campaigns/${running}/resume`)
          .set(auth(owner))
      ).status,
    ).toBe(403);
  });
});

describe('Settings → call caps + calling window warning (T8.6)', () => {
  const patch = (user: TestUser, body: object) =>
    request(app).patch('/api/v1/account').set(auth(user)).send(body);

  it('owners / admins set call caps; ranges and perWeek ≥ perDay checked', async () => {
    const caps = { perDay: 2, perWeek: 8, minGapMinutes: 60 };
    const ok = await patch(admin, { settings: { callCaps: caps } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.settings.callCaps).toEqual(caps);
    const forbidden = await patch(manager, { settings: { callCaps: caps } });
    expect([403]).toContain(forbidden.status);
    expect(
      (await patch(owner, { settings: { callCaps: { perDay: 5, perWeek: 3, minGapMinutes: 0 } } }))
        .status,
    ).toBe(422);
    expect(
      (
        await patch(owner, {
          settings: { callCaps: { perDay: 11, perWeek: 20, minGapMinutes: 0 } },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await patch(owner, {
          settings: { callCaps: { perDay: 1, perWeek: 1, minGapMinutes: 1441 } },
        })
      ).status,
    ).toBe(422);
    const stored = await AccountModel.findById(t.account._id).lean();
    expect(stored?.settings.callCaps).toEqual(caps);
  });

  it('warns when the calling window leaves the TRAI / RBI hours', async () => {
    const res = await patch(owner, {
      settings: { callingWindow: { start: '08:30', end: '20:00', days: [1, 2, 3] } },
    });
    expect(res.body.data.callingWindowWarning).toBe('outside_trai');
    const get = await request(app).get('/api/v1/account').set(auth(owner));
    expect(get.body.data.callingWindowWarning).toBe('outside_trai');
    expect(callingWindowWarning({ start: '09:00', end: '21:00' })).toBe('outside_rbi_recovery');
    expect(callingWindowWarning({ start: '09:00', end: '19:00' })).toBeNull();
    expect(callingWindowWarning({ start: '07:00', end: '18:00' })).toBe('outside_trai');
    expect(callingWindowWarning({ start: '09:00', end: '21:30' })).toBe('outside_trai');
  });
});

describe('start hardening', () => {
  it('a scheduled campaign whose flow can no longer be loaded ends failed (no retry loop)', async () => {
    const id = await campaign('later');
    await FlowModel.collection.updateOne(
      { _id: new Types.ObjectId(flowId) },
      { $set: { deletedAt: new Date() } },
    );
    try {
      await startScheduled(
        await docOf(id),
        createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      );
      expect(await docOf(id)).toMatchObject({
        status: 'failed',
        error: { code: 'CAMPAIGN_NOT_RUNNABLE' },
      });
    } finally {
      await FlowModel.collection.updateOne(
        { _id: new Types.ObjectId(flowId) },
        { $set: { deletedAt: null } },
      );
    }
  });
});
