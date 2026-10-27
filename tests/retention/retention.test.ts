import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallInsightModel } from '../../src/db/models/call-insight.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ConversationSummaryModel } from '../../src/db/models/conversation-summary.model';
import { MessageModel } from '../../src/db/models/message.model';
import { StatsDailyModel } from '../../src/db/models/stats-daily.model';
import { getCall, recordingLink } from '../../src/modules/calls/calls.service';
import { purgeCalls } from '../../src/modules/calls/maintenance';
import { runInboxRetention } from '../../src/modules/inbox/retention.job';
import { effectiveRetention, retentionMax } from '../../src/modules/retention/retention.service';
import { callDoc, messageDoc } from '../helpers/analytics';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp();
const auth = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });
const DAY = 86_400_000;
const NOW = new Date('2026-10-27T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const PLATFORM = { callsDays: 180, inboxDays: 90 };

let t: TestAccount;
let owner: TestUser;
let agent: TestUser;
let superadmin: TestUser;

const put = (u: { token: string }, body: object) =>
  request(app).put('/api/v1/account/retention').set(auth(u)).send(body);
const reset = () =>
  AccountModel.updateOne({ _id: t.account._id }, { $set: { retention: null, retentionCap: null } });

beforeAll(async () => {
  const platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-${Date.now()}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
  t = await createTestAccount();
  owner = await t.addUser('owner');
  agent = await t.addUser('agent');
});

describe('effective retention', () => {
  it('defaults to the platform, follows settings, the cap and recordings ≤ calls', () => {
    expect(effectiveRetention({}, PLATFORM)).toEqual({
      recordingsDays: 180,
      callsDays: 180,
      inboxDays: 90,
    });
    expect(
      effectiveRetention(
        { retention: { recordingsDays: 7, callsDays: 30, inboxDays: 60 }, retentionCap: null },
        PLATFORM,
      ),
    ).toEqual({ recordingsDays: 7, callsDays: 30, inboxDays: 60 });
    // a lower cap clamps settings above it (and recordings follow the calls)
    expect(
      effectiveRetention(
        {
          retention: { recordingsDays: 90, callsDays: 120, inboxDays: 60 },
          retentionCap: { callsDays: 30, inboxDays: 45 },
        },
        PLATFORM,
      ),
    ).toEqual({ recordingsDays: 30, callsDays: 30, inboxDays: 45 });
    // chats kept forever by the platform: only the account or the cap limit them
    expect(effectiveRetention({}, { callsDays: 180, inboxDays: null }).inboxDays).toBeNull();
    expect(
      retentionMax({ callsDays: null, inboxDays: 400 }, { callsDays: 180, inboxDays: null }),
    ).toEqual({ callsDays: 180, inboxDays: 400 });
  });
});

describe('/account/retention', () => {
  beforeEach(reset);

  it('shows the platform defaults with bounds (account.read)', async () => {
    const res = await request(app).get('/api/v1/account/retention').set(auth(agent));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      settings: { recordingsDays: null, callsDays: null, inboxDays: null },
      effective: { recordingsDays: 180, callsDays: 180, inboxDays: 90 },
      platform: { callsDays: 180, inboxDays: 90 },
      cap: { callsDays: null, inboxDays: null },
      bounds: {
        recordingsDays: { min: 1, max: 180 },
        callsDays: { min: 7, max: 180 },
        inboxDays: { min: 30, max: 90 },
      },
    });
  });

  it('changes within bounds (account.update), audited old → new; null goes back to the default', async () => {
    expect((await put(agent, { callsDays: 30 })).status).toBe(403);
    const res = await put(owner, { callsDays: 30, recordingsDays: 7, inboxDays: 60 });
    expect(res.status).toBe(200);
    expect(res.body.data.effective).toEqual({ recordingsDays: 7, callsDays: 30, inboxDays: 60 });
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'account.retention_updated',
    }).lean();
    expect(audit?.meta).toEqual({
      from: { recordingsDays: null, callsDays: null, inboxDays: null },
      to: { recordingsDays: 7, callsDays: 30, inboxDays: 60 },
    });
    const back = await put(owner, { recordingsDays: null, callsDays: null });
    expect(back.body.data.settings).toEqual({
      recordingsDays: null,
      callsDays: null,
      inboxDays: 60,
    });
    expect(back.body.data.effective.callsDays).toBe(180);
  });

  it('refuses days outside the bounds', async () => {
    const cases: object[] = [
      { callsDays: 6 },
      { callsDays: 181 },
      { recordingsDays: 0 },
      { callsDays: 30, recordingsDays: 31 },
      { inboxDays: 29 },
      { inboxDays: 91 },
    ];
    for (const body of cases) {
      const res = await put(owner, body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([
        422,
        'recordingsDays' in body && !('callsDays' in body)
          ? 'VALIDATION_FAILED'
          : 'RETENTION_OUT_OF_BOUNDS',
      ]);
    }
    expect((await put(owner, {})).status).toBe(422);
    expect((await put(owner, { callsDays: 30.5 })).status).toBe(422);
  });

  it('recordings above shortened calls are refused', async () => {
    await put(owner, { recordingsDays: 60 });
    const res = await put(owner, { callsDays: 30 });
    expect(res.body.error.code).toBe('RETENTION_OUT_OF_BOUNDS');
    expect(res.body.error.message).toMatch(/recordings/i);
  });
});

describe('superadmin retention cap', () => {
  beforeEach(reset);
  const cap = (u: { token: string }, body: object, id = t.account._id.toString()) =>
    request(app).put(`/api/v1/admin/accounts/${id}/retention-cap`).set(auth(u)).send(body);

  it('lowers the maximum, clamps settings, shows in the account detail; audited on both sides', async () => {
    await put(owner, { callsDays: 60, recordingsDays: 30 });
    expect((await cap(owner, { callsDays: 20, inboxDays: null })).status).toBe(403);
    const res = await cap(superadmin, { callsDays: 20, inboxDays: 45 });
    expect(res.status).toBe(200);
    expect(res.body.data.effective).toEqual({ recordingsDays: 20, callsDays: 20, inboxDays: 45 });
    expect(res.body.data.bounds.callsDays).toEqual({ min: 7, max: 20 });
    const mine = await request(app).get('/api/v1/account/retention').set(auth(owner));
    expect(mine.body.data.cap).toEqual({ callsDays: 20, inboxDays: 45 });
    expect((await put(owner, { callsDays: 21 })).body.error.code).toBe('RETENTION_OUT_OF_BOUNDS');
    const detail = await request(app)
      .get(`/api/v1/admin/accounts/${t.account._id.toString()}`)
      .set(auth(superadmin));
    expect(detail.body.data.retention.effective.callsDays).toBe(20);
    expect(await AuditLogModel.countDocuments({ action: 'account.retention_cap_updated' })).toBe(2);
  });

  it('refuses caps outside the platform range and unknown accounts', async () => {
    expect((await cap(superadmin, { callsDays: 6, inboxDays: null })).body.error.code).toBe(
      'RETENTION_OUT_OF_BOUNDS',
    );
    expect((await cap(superadmin, { callsDays: 181, inboxDays: null })).status).toBe(422);
    expect((await cap(superadmin, { callsDays: null, inboxDays: 29 })).status).toBe(422);
    expect((await cap(superadmin, { callsDays: null })).status).toBe(422);
    expect(
      (await cap(superadmin, { callsDays: null, inboxDays: null }, new Types.ObjectId().toString()))
        .status,
    ).toBe(404);
  });
});

describe('per-account purge', () => {
  it('deletes per account, keeps recording-only calls and their insights, other accounts and rollups', async () => {
    const short = await createTestAccount();
    const other = await createTestAccount();
    await AccountModel.updateOne(
      { _id: short.account._id },
      { $set: { retention: { recordingsDays: 7, callsDays: 30, inboxDays: 60 } } },
    );
    const withRecording = async (accountId: Types.ObjectId, days: number) => {
      const key = `accounts/${accountId.toString()}/recordings/${new Types.ObjectId().toString()}.wav`;
      await storage.put(key, Buffer.from('RIFF'), { contentType: 'audio/wav' });
      const call = callDoc(accountId, {
        createdAt: ago(days),
        provider: 'sip',
        cost: emptyCallCost(),
        recording: { fileKey: key, durationSec: 5, sizeBytes: 4, format: 'wav' },
        metrics: emptyCallMetrics(),
        variables: {},
        outcome: {},
        error: null,
        languageDetected: null,
        flowRunId: null,
        insights: null,
        dispositionSource: null,
      });
      await CallModel.collection.insertOne(call);
      return { call, key };
    };
    const recent = await withRecording(short.account._id, 10); // file goes, call stays
    const fresh = await withRecording(short.account._id, 3); // all stays
    const old = await withRecording(short.account._id, 40); // all goes
    const otherOld = await withRecording(other.account._id, 40); // default 180: stays
    const ancient = await withRecording(other.account._id, 200); // default: goes
    await CallInsightModel.create({
      accountId: short.account._id,
      callId: recent.call._id,
      version: 1,
      status: 'done',
    });
    await StatsDailyModel.collection.insertOne({
      accountId: short.account._id,
      day: '2026-08-01',
      channel: 'voice',
      test: false,
      kind: 'all',
      refId: null,
      counters: { calls_attempted: 3 },
    });

    expect(await purgeCalls(storage, 180, NOW)).toEqual({ calls: 2, recordings: 1 });
    expect(await CallModel.exists({ _id: old.call._id })).toBeNull();
    expect(await CallModel.exists({ _id: ancient.call._id })).toBeNull();
    expect(await storage.exists(old.key)).toBe(false);
    const kept = await CallModel.findById(recent.call._id).lean();
    expect(kept?.recording?.deletedAt).toEqual(NOW);
    expect(await storage.exists(recent.key)).toBe(false);
    expect(await CallInsightModel.exists({ callId: recent.call._id })).toBeTruthy();
    expect((await CallModel.findById(fresh.call._id).lean())?.recording?.deletedAt).toBeFalsy();
    expect(await storage.exists(fresh.key)).toBe(true);
    expect(await storage.exists(otherOld.key)).toBe(true);
    expect(await StatsDailyModel.countDocuments({ accountId: short.account._id })).toBe(1);
    // the next run has nothing left to do
    expect(await purgeCalls(storage, 180, NOW)).toEqual({ calls: 0, recordings: 0 });

    // the call view says the file is gone; the link is refused
    const req = {
      auth: {
        accountId: short.account._id.toString(),
        userId: new Types.ObjectId().toString(),
        permissions: new Set<string>(),
      },
    } as never;
    expect((await getCall(req, recent.call._id.toString())).recording).toEqual({
      durationSec: 5,
      sizeBytes: 4,
      deletedAt: NOW.toISOString(),
    });
    await expect(recordingLink(req, recent.call._id.toString(), { storage })).rejects.toThrow(
      /retention/,
    );

    // chats: 60 days for the short account, the platform's 90 for the other
    await MessageModel.collection.insertMany([
      messageDoc(short.account._id, { at: ago(70) }),
      messageDoc(short.account._id, { at: ago(40) }),
      messageDoc(other.account._id, { at: ago(70) }),
      messageDoc(other.account._id, { at: ago(100) }),
    ] as never[]);
    await ConversationSummaryModel.collection.insertMany([
      { accountId: short.account._id, conversationId: new Types.ObjectId(), createdAt: ago(70) },
      { accountId: other.account._id, conversationId: new Types.ObjectId(), createdAt: ago(70) },
    ] as never[]);
    const inbox = await runInboxRetention(storage, 90, NOW);
    expect(inbox).toMatchObject({ messages: 2, summaries: 1 });
    expect(await MessageModel.countDocuments({ accountId: short.account._id })).toBe(1);
    expect(await MessageModel.countDocuments({ accountId: other.account._id })).toBe(1);
    expect(await ConversationSummaryModel.countDocuments({ accountId: other.account._id })).toBe(1);
  });

  it('a superadmin cap shortens an account that never chose', async () => {
    const capped = await createTestAccount();
    await AccountModel.updateOne(
      { _id: capped.account._id },
      { $set: { retentionCap: { callsDays: 14, inboxDays: null } } },
    );
    const call = callDoc(capped.account._id, { createdAt: ago(20), cost: emptyCallCost() });
    await CallModel.collection.insertOne(call);
    expect((await purgeCalls(undefined, 180, NOW)).calls).toBeGreaterThanOrEqual(1);
    expect(await CallModel.exists({ _id: call._id })).toBeNull();
  });
});
