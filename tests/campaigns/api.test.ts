import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { createFakeProvider } from '../../src/core/ai';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { RoleModel } from '../../src/db/models/role.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { createDryRunPrograms } from '../../src/modules/calls/dry-run';
import { CallRegistry } from '../../src/modules/calls/registry';
import { authorizeTopic } from '../../src/modules/calls/topic-auth';
import { runCampaignExport } from '../../src/modules/campaigns/export';
import { parseXlsx } from '../../src/modules/contact-imports/parsers/xlsx';
import { purgeExportFiles } from '../../src/modules/contacts/retention';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { FLOWS, auth } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-campaign-api-'));
const prefix = `${uniquePrefix('campaign-api')}:`;
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const enqueued: { accountId: string; exportJobId: string }[] = [];
let manager: CallManager;
let redis: Redis;
let server: Server;

const extraPorts: number[] = [];
let app: ReturnType<typeof buildTestApp>;

let t: TestAccount;
let other: TestAccount;
let owner: TestUser;
let admin: TestUser;
let manager_: TestUser;
let agent: TestUser;
let viewer: TestUser;
let exporter: TestUser;
let otherOwner: TestUser;
let flowId: string;
let agentId: string;
let listId: string;
let contactIds: string[] = [];

const BASE = '/api/v1/campaigns';
const ALL_DAY = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };

beforeAll(async () => {
  redis = (await requireRedis()).client;
  await ensureRateCard();
  const env = loadEnv({ VOICE_PROVIDER: 'fake' });
  const registry = new CallRegistry(redis, prefix);
  manager = new CallManager({
    logger,
    registry,
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    scriptFor: () => Promise.reject(new Error('no web calls here')),
    dryRun: createDryRunPrograms({ env, storage, redis }),
  });
  app = buildTestApp(
    {},
    {
      storage,
      aiProvider: createFakeProvider(),
      aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
      campaigns: {
        exports: {
          enqueue: (data) => {
            enqueued.push(data);
            return Promise.resolve();
          },
        },
      },
      calls: { manager, registry, textInput: false, voiceProvider: 'fake' },
    },
  );
  server = app.listen(0);
  extraPorts.push((server.address() as AddressInfo).port);
  t = await createTestAccount({ name: 'API Co' });
  owner = await t.addUser('owner');
  admin = await t.addUser('admin');
  manager_ = await t.addUser('manager');
  agent = await t.addUser('agent');
  viewer = await t.addUser('viewer');
  // campaigns.export without contacts.export → masked phones
  const role = await RoleModel.create({
    accountId: t.account._id,
    key: 'exporter',
    name: 'Exporter',
    permissions: ['campaigns.read', 'campaigns.export'],
  });
  exporter = await t.addUser('viewer', { roleId: role._id });
  other = await createTestAccount({ name: 'Other Co' });
  otherOwner = await other.addUser('owner');
  await AccountModel.updateOne({ _id: t.account._id }, { 'settings.callingWindow': ALL_DAY });
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'amount',
    label: 'Amount due',
    type: 'currency',
  });
  const created = await request(app)
    .post('/api/v1/agents')
    .set(auth(owner))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  agentId = created.body.data.id;
  const flow = await request(app)
    .post(FLOWS)
    .set(auth(owner))
    .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
  flowId = flow.body.data.id;
  await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: flow.body.data.revision });
  listId = (
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'API list',
      source: { type: 'manual' },
    })
  )._id.toString();
  const names = ['=SUM(1+1)', 'Asha Verma', 'Ravi Kumar'];
  contactIds = [];
  for (const [i, name] of names.entries()) {
    const c = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: `+9190003${String(i + 1).padStart(5, '0')}`,
      name,
      source: { type: 'manual' },
      listIds: [new Types.ObjectId(listId)],
      variables: { amount: 1_234_500_000 },
    });
    contactIds.push(c._id.toString());
  }
});
afterAll(async () => {
  await manager.shutdown();
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((done) => server.close(() => done()));
});

let n = 0;
const draft = async (user: TestUser = manager_, over: Record<string, unknown> = {}) => {
  n += 1;
  return request(app)
    .post(BASE)
    .set(auth(user))
    .send({
      name: `API run ${String(n)}`,
      mode: 'dry_run',
      flowId,
      audience: { listIds: [listId], excludeActiveCampaigns: false },
      window: ALL_DAY,
      ...over,
    });
};
const start = (user: TestUser, id: string, key = `k-${String(Math.random())}`) =>
  request(app).post(`${BASE}/${id}/start`).set(auth(user)).set('Idempotency-Key', key);
const readAll = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe('campaigns API × roles (PHASE_8_PLAN §1q / §1r)', () => {
  it('reads for every role; writes / run / export for owner, admin, manager only', async () => {
    const id = (await draft()).body.data.id as string;
    for (const user of [owner, admin, manager_, agent, viewer]) {
      expect((await request(app).get(BASE).set(auth(user))).status).toBe(200);
      expect((await request(app).get(`${BASE}/${id}`).set(auth(user))).status).toBe(200);
    }
    for (const user of [owner, admin, manager_]) {
      expect((await draft(user)).status).toBe(201);
    }
    for (const user of [agent, viewer]) {
      expect((await draft(user)).status).toBe(403);
      expect((await start(user, id)).status).toBe(403);
      expect((await request(app).post(`${BASE}/${id}/pause`).set(auth(user))).status).toBe(403);
      expect(
        (await request(app).post(`${BASE}/${id}/export`).set(auth(user)).send({})).status,
      ).toBe(403);
      expect((await request(app).delete(`${BASE}/${id}`).set(auth(user))).status).toBe(403);
    }
    expect((await request(app).get(BASE)).status).toBe(401);
  });

  it('impersonators read but never change; suspended accounts are read-only', async () => {
    const id = (await draft()).body.data.id as string;
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    expect((await request(app).get(`${BASE}/${id}`).set(auth(imp))).status).toBe(200);
    const blocked = await start(imp as TestUser, id);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const s = await createTestAccount({ name: 'Suspended Co', status: 'suspended' });
    const sOwner = await s.addUser('owner');
    expect((await request(app).get(BASE).set(auth(sOwner))).status).toBe(200);
    expect((await draft(sOwner)).status).toBe(403);
  });

  it('the whole lifecycle over HTTP: revision conflict, preview, estimate, idempotent start, contacts, cancel, delete', async () => {
    const created = await draft();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const stale = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(manager_))
      .send({ revision: created.body.data.revision + 5, name: 'Renamed' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CAMPAIGN_REVISION_CONFLICT');
    const renamed = await request(app)
      .patch(`${BASE}/${id}`)
      .set(auth(manager_))
      .send({ revision: created.body.data.revision, name: `Renamed ${id}` });
    expect(renamed.status).toBe(200);
    const preview = await request(app)
      .post(`${BASE}/audience/preview`)
      .set(auth(viewer))
      .send({ flowId, audience: { listIds: [listId] } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.total).toBe(3);
    expect(JSON.stringify(preview.body)).not.toContain('+9190003');
    const estimate = await request(app).post(`${BASE}/${id}/estimate`).set(auth(viewer));
    expect(estimate.status).toBe(200);
    expect(estimate.body.data.contacts).toBe(3);
    expect((await request(app).post(`${BASE}/${id}/start`).set(auth(manager_))).status).toBe(422);
    const first = await start(manager_, id, `start-${id}`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.status).toBe('running');
    const replay = await start(manager_, id, `start-${id}`);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(
      await AuditLogModel.countDocuments({ action: 'campaign.started', 'target.id': id }),
    ).toBe(1);
    const contacts = await request(app).get(`${BASE}/${id}/contacts`).set(auth(viewer));
    expect(contacts.status).toBe(200);
    expect(contacts.body.data).toHaveLength(3);
    expect(contacts.body.meta).toMatchObject({ hasMore: false });
    expect(JSON.stringify(contacts.body)).not.toContain('+9190003');
    const pending = await request(app)
      .get(`${BASE}/${id}/contacts`)
      .query({ status: 'pending', limit: 2 })
      .set(auth(viewer));
    expect(pending.body.data).toHaveLength(2);
    expect(pending.body.meta.hasMore).toBe(true);
    expect(
      (await request(app).post(`${BASE}/${id}/pause`).set(auth(manager_))).body.data.status,
    ).toBe('paused');
    expect(
      (await request(app).post(`${BASE}/${id}/resume`).set(auth(manager_))).body.data.status,
    ).toBe('running');
    expect((await request(app).delete(`${BASE}/${id}`).set(auth(manager_))).status).toBe(409);
    const canceled = await request(app)
      .post(`${BASE}/${id}/cancel`)
      .set(auth(manager_))
      .send({ hangUpLive: false });
    expect(canceled.body.data.status).toBe('canceled');
    expect((await request(app).post(`${BASE}/${id}/resume`).set(auth(manager_))).status).toBe(409);
    const copy = await request(app).post(`${BASE}/${id}/duplicate`).set(auth(manager_));
    expect(copy.status).toBe(201);
    expect(copy.body.data.status).toBe('draft');
    expect((await request(app).delete(`${BASE}/${id}`).set(auth(manager_))).status).toBe(204);
    expect((await request(app).get(`${BASE}/${id}`).set(auth(manager_))).status).toBe(404);
  });

  it('scheduled → unschedule; recurring parents list their runs', async () => {
    const later = await draft(manager_, {
      schedule: { startAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    const id = later.body.data.id as string;
    expect((await start(manager_, id)).body.data.status).toBe('scheduled');
    expect(
      (await request(app).post(`${BASE}/${id}/unschedule`).set(auth(manager_))).body.data.status,
    ).toBe('draft');
    const runs = await request(app).get(`${BASE}/${id}/runs`).set(auth(viewer));
    expect(runs.status).toBe(200);
    expect(runs.body.data).toEqual([]);
  });

  it('isolation: another account gets 404 for campaigns, contacts, runs, export and actions', async () => {
    const id = (await draft()).body.data.id as string;
    for (const [method, url] of [
      ['get', `${BASE}/${id}`],
      ['get', `${BASE}/${id}/contacts`],
      ['get', `${BASE}/${id}/runs`],
      ['post', `${BASE}/${id}/estimate`],
      ['post', `${BASE}/${id}/export`],
      ['post', `${BASE}/${id}/pause`],
      ['post', `${BASE}/${id}/duplicate`],
      ['delete', `${BASE}/${id}`],
    ] as const) {
      const res = await request(app)[method](url).set(auth(otherOwner)).send({});
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const list = await request(app).get(BASE).set(auth(otherOwner));
    expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(id);
    expect((await start(otherOwner, id)).status).toBe(404);
  });

  it('validation: bad ids 422, unknown fields 422, rate limit ids', async () => {
    expect((await request(app).get(`${BASE}/not-an-id`).set(auth(viewer))).status).toBe(422);
    expect((await draft(manager_, { surprise: true })).status).toBe(422);
  });
});

describe('results export (PHASE_8_PLAN §1n)', () => {
  const finishedCampaign = async () => {
    const id = (await draft()).body.data.id as string;
    await start(manager_, id);
    const rows = await CampaignContactModel.find({ campaignId: id }).sort({ seq: 1 });
    const call = await CallModel.create({
      accountId: t.account._id,
      direction: 'outbound',
      provider: 'dryrun',
      from: 'dryrun',
      to: rows[1]?.phoneE164,
      isTest: true,
      charged: false,
      source: { kind: 'flow', flowId: new Types.ObjectId(flowId), flowVersionRef: 1 },
      contactId: rows[1]?.contactId,
      campaignId: new Types.ObjectId(id),
      campaignContactId: rows[1]?._id,
      attempt: 1,
      status: 'completed',
      durationSec: 42,
      timestamps: { queuedAt: new Date() },
    });
    await CampaignContactModel.updateOne(
      { _id: rows[1]?._id },
      {
        status: 'completed',
        attempts: 1,
        lastResult: 'answered',
        disposition: 'promise_to_pay',
        promiseToPay: { date: '2026-10-25', amountMicros: 500_000_000 },
        lastAttemptAt: new Date('2026-10-19T05:30:00Z'),
        lastCallId: call._id,
        costMicros: 2_345_000,
      },
    );
    await CampaignContactModel.updateOne(
      { _id: rows[2]?._id },
      { status: 'skipped', skipReason: 'dnd' },
    );
    return id;
  };
  const exportAs = async (user: TestUser, id: string, format: 'csv' | 'xlsx') => {
    const res = await request(app).post(`${BASE}/${id}/export`).set(auth(user)).send({ format });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data).toMatchObject({ kind: 'campaign_results', campaignId: id, format });
    const job = enqueued.at(-1) as { accountId: string; exportJobId: string };
    expect(job.exportJobId).toBe(res.body.data.id);
    expect(await runCampaignExport(job, { storage, logger })).toMatchObject({ status: 'ready' });
    const doc = await ExportJobModel.findById(job.exportJobId).lean();
    return { id: job.exportJobId, file: await readAll(await storage.get(doc?.fileKey as string)) };
  };

  it('CSV: BOM, headers, labels, ₹ amounts, formula-safe names, full phones with contacts.export', async () => {
    const id = await finishedCampaign();
    const { file } = await exportAs(manager_, id, 'csv');
    expect(file.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const lines = file.toString('utf8').slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'Name,Phone,Status,Attempts,Last result,Disposition,Promise date,Promise amount,Callback,Last call at (IST),Duration (s),Cost (₹),Skip reason,Call id,Amount due',
    );
    expect(lines[1]).toMatch(/^'=SUM\(1\+1\),\+919000300001,pending,0,/);
    expect(lines[2]).toContain(
      'Asha Verma,+919000300002,completed,1,answered,promise_to_pay,2026-10-25,₹500.00,,2026-10-19 11:00,42,₹2.35,,',
    );
    expect(lines[2]).toMatch(/,"₹1,234\.50"$/); // money via the ₹ formatter, quoted by CSV
    expect(lines[3]).toContain(',skipped,0,');
    expect(lines[3]).toContain(',dnd,');
    expect(
      await AuditLogModel.countDocuments({ action: 'campaign.exported', 'target.id': id }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('XLSX + masked phones without contacts.export; the link checks the kind permission', async () => {
    const id = await finishedCampaign();
    const { id: exportId, file } = await exportAs(exporter, id, 'xlsx');
    const sheet = await parseXlsx(file);
    expect(sheet.header.slice(0, 3)).toEqual(['Name', 'Phone', 'Status']);
    expect(sheet.rows[1]?.cells[1]).toBe('+91******0002');
    // the exporter downloads it; contacts-only exporters and others don't see it
    const link = await request(app).get(`/api/v1/contact-exports/${exportId}`).set(auth(exporter));
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.data.downloadUrl).toEqual(expect.any(String));
    const contactsOnly = await RoleModel.create({
      accountId: t.account._id,
      key: 'contacts_exporter',
      name: 'Contacts exporter',
      permissions: ['contacts.read', 'contacts.export'],
    });
    const cx = await t.addUser('viewer', { roleId: contactsOnly._id });
    expect(
      (await request(app).get(`/api/v1/contact-exports/${exportId}`).set(auth(cx))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/v1/contact-exports/${exportId}`).set(auth(viewer))).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/v1/contact-exports/${exportId}`).set(auth(otherOwner))).status,
    ).toBe(404);
    // the contact export list shows contact exports only
    const listed = await request(app).get('/api/v1/contact-exports').set(auth(owner));
    expect(listed.body.data.map((e: { id: string }) => e.id)).not.toContain(exportId);
    // files are purged like contact exports
    await ExportJobModel.updateOne({ _id: exportId }, { expiresAt: new Date(Date.now() - 1000) });
    await purgeExportFiles(storage);
    expect(await ExportJobModel.findById(exportId).lean()).toMatchObject({
      status: 'expired',
      fileKey: null,
    });
  });

  it('one export at a time per account; a vanished campaign fails the job', async () => {
    const id = await finishedCampaign();
    const first = await request(app).post(`${BASE}/${id}/export`).set(auth(manager_)).send({});
    expect(first.status).toBe(202);
    const second = await request(app).post(`${BASE}/${id}/export`).set(auth(manager_)).send({});
    expect(second.status).toBe(409);
    await CampaignModel.collection.deleteOne({ _id: new Types.ObjectId(id) });
    const job = enqueued.at(-1) as { accountId: string; exportJobId: string };
    expect(await runCampaignExport(job, { storage, logger })).toEqual({ status: 'failed' });
    expect(await runCampaignExport(job, { storage, logger })).toEqual({ status: 'skipped' });
  });
});

describe('POST /calls — single call (PHASE_8_PLAN §1o)', () => {
  const call = (user: TestUser, body: object, key = `c-${String(Math.random())}`) =>
    request(app).post('/api/v1/calls').set(auth(user)).set('Idempotency-Key', key).send(body);

  it('dials through the dry-run line: 201 view, never charged, audited, idempotent, filterable', async () => {
    // a contact nobody called yet (the export tests "called" the others)
    const contactId = (
      await ContactModel.create({
        accountId: t.account._id,
        phoneE164: '+919000300099',
        name: 'Asha Verma',
        source: { type: 'manual' },
        variables: { amount: 1_000_000_000 },
      })
    )._id.toString();
    const res = await call(agent, { contactId, flowId }, 'one-call');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      provider: 'dryrun',
      isTest: true,
      charged: false,
      campaign: null,
      contact: { id: contactId, name: 'Asha Verma' },
      source: { kind: 'flow', flowId, flowVersionRef: 1 },
    });
    expect(JSON.stringify(res.body)).not.toContain('+9190003');
    const replay = await call(agent, { contactId, flowId }, 'one-call');
    expect(replay.body.data.id).toBe(res.body.data.id);
    expect(await CallModel.countDocuments({ contactId, provider: 'dryrun' })).toBe(1);
    expect(
      await AuditLogModel.findOne({
        action: 'call.triggered',
        'target.id': res.body.data.id,
      }).lean(),
    ).toMatchObject({ meta: { provider: 'dryrun', source: 'flow' } });
    const listed = await request(app)
      .get('/api/v1/calls')
      .query({ provider: 'dryrun', contactId })
      .set(auth(viewer));
    expect(listed.body.data.map((c: { id: string }) => c.id)).toEqual([res.body.data.id]);
    await manager
      .hangup(t.account._id.toString(), res.body.data.id as string)
      .catch(() => undefined);
  });

  it('agents too; bodies need exactly one source and the key; viewers cannot call', async () => {
    const res = await call(manager_, { contactId: contactIds[2], agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.source).toMatchObject({ kind: 'agent', agentId });
    await manager
      .hangup(t.account._id.toString(), res.body.data.id as string)
      .catch(() => undefined);
    expect((await call(manager_, { contactId: contactIds[2] })).status).toBe(422);
    expect((await call(manager_, { contactId: contactIds[2], flowId, agentId })).status).toBe(422);
    expect(
      (
        await request(app)
          .post('/api/v1/calls')
          .set(auth(manager_))
          .send({ contactId: contactIds[2], flowId })
      ).status,
    ).toBe(422);
    expect((await call(viewer, { contactId: contactIds[2], flowId })).status).toBe(403);
    expect((await call(otherOwner, { contactId: contactIds[2], flowId })).status).toBe(404);
  });

  it('the dial guard refuses with exact messages', async () => {
    const fresh = async (over: Record<string, unknown> = {}) =>
      (
        await ContactModel.create({
          accountId: t.account._id,
          phoneE164: `+9190002${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
          name: 'Guarded',
          source: { type: 'manual' },
          ...over,
        })
      )._id.toString();
    const refused = async (contactId: string) => {
      const res = await call(owner, { contactId, flowId });
      return {
        status: res.status,
        code: res.body.error?.code,
        message: res.body.error?.details?.[0]?.message,
      };
    };
    const dnd = await fresh();
    const dndPhone = (await ContactModel.findById(dnd).lean())?.phoneE164 as string;
    await DndEntryModel.create({ accountId: t.account._id, phoneE164: dndPhone, source: 'manual' });
    expect(await refused(dnd)).toEqual({
      status: 422,
      code: 'CALL_NOT_ALLOWED',
      message: 'On the do-not-call list',
    });
    expect(await refused(await fresh({ optedOutAt: new Date() }))).toEqual({
      status: 422,
      code: 'CALL_NOT_ALLOWED',
      message: 'Opted out',
    });
    const busy = await fresh();
    const dial = (at: Date) =>
      CallModel.create({
        accountId: t.account._id,
        direction: 'outbound',
        provider: 'dryrun',
        from: 'dryrun',
        to: '+910000000000',
        isTest: true,
        charged: false,
        source: { kind: 'flow', flowId: new Types.ObjectId(flowId), flowVersionRef: 1 },
        contactId: new Types.ObjectId(busy),
        status: 'completed',
        timestamps: { queuedAt: at },
        createdAt: at,
      });
    await dial(new Date(Date.now() - 5 * 60_000));
    expect(await refused(busy)).toEqual({
      status: 422,
      code: 'CALL_NOT_ALLOWED',
      message: 'Called less than 30 minutes ago',
    });
    await AccountModel.updateOne({ _id: t.account._id }, { 'settings.callCaps.perDay': 1 });
    try {
      expect((await refused(busy)).message).toBe('Daily call limit reached');
      await AccountModel.updateOne(
        { _id: t.account._id },
        { 'settings.callCaps.perWeek': 1, 'settings.callCaps.perDay': 1 },
      );
      expect((await refused(busy)).message).toBe('Weekly call limit reached');
    } finally {
      await AccountModel.updateOne(
        { _id: t.account._id },
        { 'settings.callCaps': { perDay: 3, perWeek: 10, minGapMinutes: 30 } },
      );
    }
    const today = new Date().getDay();
    await AccountModel.updateOne(
      { _id: t.account._id },
      { 'settings.callingWindow': { ...ALL_DAY, days: [(today + 1) % 7] } },
    );
    try {
      const outside = await refused(await fresh());
      expect(outside).toMatchObject({ status: 422, code: 'CALL_OUTSIDE_WINDOW' });
      expect(new Date(outside.message as string).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await AccountModel.updateOne({ _id: t.account._id }, { 'settings.callingWindow': ALL_DAY });
    }
  });
});

describe('GET /calls campaign view + filters', () => {
  it('campaign calls show the campaign and attempt; filter by campaignId', async () => {
    const id = (await draft()).body.data.id as string;
    const c = await CallModel.create({
      accountId: t.account._id,
      direction: 'outbound',
      provider: 'dryrun',
      from: 'dryrun',
      to: '+910000000001',
      isTest: true,
      charged: false,
      source: { kind: 'flow', flowId: new Types.ObjectId(flowId), flowVersionRef: 1 },
      campaignId: new Types.ObjectId(id),
      campaignContactId: new Types.ObjectId(),
      attempt: 2,
      status: 'completed',
      timestamps: { queuedAt: new Date() },
    });
    const res = await request(app).get('/api/v1/calls').query({ campaignId: id }).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: c._id.toString(),
      campaign: { id, name: expect.stringMatching(/^API run/), attempt: 2 },
      charged: false,
    });
  });
});

describe('campaign:<id> topic (PHASE_8_PROMPT §1 "WS")', () => {
  it('own account with campaigns.read ✓, other account ✗, no permission ✗, superadmin viewing ✓', async () => {
    const id = (await draft()).body.data.id as string;
    const topic = { kind: 'campaign' as const, id };
    const ctx = (user: TestUser, account: TestAccount = t) => ({
      accountId: account.account._id.toString(),
      userId: user.user._id.toString(),
    });
    expect(await authorizeTopic(ctx(viewer), topic)).toBe(true);
    expect(await authorizeTopic(ctx(owner), topic)).toBe(true);
    expect(await authorizeTopic(ctx(otherOwner, other), topic)).toBe(false);
    const noRead = await RoleModel.create({
      accountId: t.account._id,
      key: 'no_campaigns',
      name: 'No campaigns',
      permissions: ['contacts.read'],
    });
    const blind = await t.addUser('viewer', { roleId: noRead._id });
    expect(await authorizeTopic(ctx(blind), topic)).toBe(false);
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `platform-${String(Date.now())}`,
      name: 'Platform',
    });
    const superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
    expect(
      await authorizeTopic(
        { accountId: t.account._id.toString(), userId: superadmin.user._id.toString() },
        topic,
      ),
    ).toBe(true);
    expect(await authorizeTopic(ctx(viewer), { kind: 'campaign', id: 'zz' })).toBe(false);
    expect(
      await authorizeTopic(ctx(viewer), { kind: 'campaign', id: new Types.ObjectId().toString() }),
    ).toBe(false);
  });
});
