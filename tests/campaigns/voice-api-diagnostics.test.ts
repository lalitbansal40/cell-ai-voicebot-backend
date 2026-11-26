import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetEnvForTests } from '../../src/config/env';
import { FakeVoiceClient, setVoiceApiClient } from '../../src/core/voice-api';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { UserModel } from '../../src/db/models/user.model';
import { readVoiceApiHealth } from '../../src/modules/admin/system.service';
import {
  listCampaignContacts,
  voiceIvrDigits,
} from '../../src/modules/campaigns/campaigns.service';
import { setVoiceStorage } from '../../src/modules/campaigns/voice-api/batch';
import { setVoiceJobs } from '../../src/modules/campaigns/voice-api/jobs';
import { noteUnknownVoiceStatus } from '../../src/modules/voice-api/diagnostics';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';
import { reqFor, voiceWorld } from '../helpers/voice';

/** IVR: Cell24x7 checks a superadmin runs from the panel (no server access). */
useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage });
const prefix = uniquePrefix('vapi-diag');
const saved = process.env.VOICE_API_PROVIDER;
let redis: Redis;
let fake: FakeVoiceClient;
let superadmin: TestUser;
const as = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

beforeAll(async () => {
  process.env.VOICE_API_PROVIDER = 'fake';
  resetEnvForTests();
  redis = (await requireRedis()).client;
  fake = new FakeVoiceClient(redis, { delayMs: 0, prefix });
  setVoiceApiClient(fake);
  setVoiceJobs(null);
  setVoiceStorage(storage);
  await ensureRateCard();
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

afterAll(async () => {
  fake.stop();
  setVoiceApiClient(null);
  setVoiceStorage(undefined);
  if (saved === undefined) delete process.env.VOICE_API_PROVIDER;
  else process.env.VOICE_API_PROVIDER = saved;
  resetEnvForTests();
  await flushPrefix(redis, prefix);
});

describe('Test connection (IVR-T1)', () => {
  it('ok, then 401 and 402 with their reason; saved on the account and audited', async () => {
    const w = await voiceWorld(storage);
    const url = `/api/v1/admin/accounts/${w.accountId.toString()}/voice-api/test-connection`;
    const ok = await request(app).post(url).set(as(superadmin));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ ok: true, reason: 'ok', ivrs: 2 });
    fake.failNext('401');
    expect((await request(app).post(url).set(as(superadmin))).body.data).toMatchObject({
      ok: false,
      reason: 'auth',
      httpStatus: 401,
    });
    fake.failNext('402');
    expect((await request(app).post(url).set(as(superadmin))).body.data.reason).toBe('no_credits');
    fake.failNext('timeout');
    expect((await request(app).post(url).set(as(superadmin))).body.data.ok).toBe(false);
    const row = await AccountModel.findById(w.accountId).lean();
    expect((row?.voiceApi as { lastCheck?: { ok: boolean } }).lastCheck?.ok).toBe(false);
    expect(
      await AuditLogModel.countDocuments({
        action: 'voice_api.connection_tested',
        accountId: w.accountId,
      }),
    ).toBe(4);
    const diag = await request(app)
      .get(`/api/v1/admin/accounts/${w.accountId.toString()}/voice-api/diagnostics`)
      .set(as(superadmin));
    expect(diag.body.data).toMatchObject({ incoming: 'not_available' });
    expect(diag.body.data.noCredits24h).toBeGreaterThanOrEqual(1);
    // the account's owner can't run it
    const owner = await createTestAccount();
    const ownerUser = await owner.addUser('owner');
    expect((await request(app).post(url).set(as(ownerUser))).status).toBe(403);
  });
});

describe('Send test call (IVR-T2) + last provider answer (IVR-T3)', () => {
  it("needs the owner's OK and a 10-digit mobile; submits one number; the result and shape come back", async () => {
    const w = await voiceWorld(storage);
    const base = `/api/v1/admin/accounts/${w.accountId.toString()}/voice-api/test-call`;
    const noOk = await request(app)
      .post(base)
      .set(as(superadmin))
      .send({ phone: '9876543215', content: { kind: 'ivr', ivrId: 101 }, ownerApproved: false });
    expect(noOk.status).toBe(422);
    const bad = await request(app)
      .post(base)
      .set(as(superadmin))
      .send({ phone: '12345678901', content: { kind: 'ivr', ivrId: 101 }, ownerApproved: true });
    expect(bad.status).toBe(422);
    const sent = await request(app)
      .post(base)
      .set(as(superadmin))
      .send({
        phone: '9876543215',
        content: { kind: 'audio', flowAudioId: w.audioId },
        ownerApproved: true,
      });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data).toMatchObject({ phoneLast4: '3215', content: 'audio' });
    expect(fake.submits.at(-1)?.numbers).toEqual(['9876543215']);
    const result = await request(app).get(base).set(as(superadmin));
    expect(result.status).toBe(200);
    expect(result.body.data.result).toMatchObject({ status: 'ANSWERED' });
    const diag = await request(app)
      .get(`/api/v1/admin/accounts/${w.accountId.toString()}/voice-api/diagnostics`)
      .set(as(superadmin));
    expect(diag.body.data.audio).toEqual([
      expect.objectContaining({ id: w.audioId, name: expect.any(String) }),
    ]);
    expect(diag.body.data.lastShape.details).toMatchObject({
      source: 'details',
      keys: expect.arrayContaining(['receiver', 'status']),
    });
    // the sample never carries the full number
    expect(JSON.stringify(diag.body.data.lastShape)).not.toContain('9876543215');
    expect(
      await AuditLogModel.countDocuments({
        action: 'voice_api.test_call_sent',
        accountId: w.accountId,
      }),
    ).toBe(1);
  });

  it("another account's audio is refused", async () => {
    const w = await voiceWorld(storage);
    const other = await voiceWorld(storage);
    const res = await request(app)
      .post(`/api/v1/admin/accounts/${w.accountId.toString()}/voice-api/test-call`)
      .set(as(superadmin))
      .send({
        phone: '9876543215',
        content: { kind: 'audio', flowAudioId: other.audioId },
        ownerApproved: true,
      });
    expect([404, 422]).toContain(res.status);
  });

  it('3 test calls an hour per account', async () => {
    const w = await voiceWorld(storage);
    const base = `/api/v1/admin/accounts/${w.accountId.toString()}/voice-api/test-call`;
    let last = 0;
    for (let i = 0; i < 4; i += 1) {
      last = (
        await request(app)
          .post(base)
          .set(as(superadmin))
          .send({ phone: '9876543215', content: { kind: 'ivr', ivrId: 101 }, ownerApproved: true })
      ).status;
    }
    expect(last).toBe(429);
  });

  it('an unknown provider status is remembered once', async () => {
    await noteUnknownVoiceStatus('RINGING_LONG');
    await noteUnknownVoiceStatus('ANSWERED');
    expect(await redis.sismember('voiceapi:unknown-statuses', 'RINGING_LONG')).toBe(1);
    expect(await redis.sismember('voiceapi:unknown-statuses', 'ANSWERED')).toBe(0);
  });
});

describe('IVR key-press report (IVR-T4)', () => {
  it('counts final numbers per key (no key → none) and filters the results', async () => {
    const w = await voiceWorld(storage);
    const campaign = { _id: new Types.ObjectId() };
    const finals = [
      ['1', '+919000000001'],
      ['1', '+919000000002'],
      ['2', '+919000000003'],
      [null, '+919000000004'],
    ] as const;
    let seq = 0;
    for (const [dtmf, phone] of finals) {
      seq += 1;
      await CampaignContactModel.collection.insertOne({
        accountId: w.accountId,
        campaignId: campaign._id,
        contactId: new Types.ObjectId(),
        phoneE164: phone,
        seq,
        status: 'completed',
        voiceApi: { finalAt: new Date(), dtmf },
      });
    }
    expect(await voiceIvrDigits(campaign._id)).toEqual({ '1': 2, '2': 1, none: 1 });
    const owner = await UserModel.findOne({ accountId: w.accountId }).lean();
    const req = reqFor(w.accountId, owner!._id);
    await CampaignModel.collection.insertOne({
      _id: campaign._id,
      accountId: w.accountId,
      name: 'IVR',
      line: 'voice_api',
      deletedAt: null,
    });
    const pressed1 = await listCampaignContacts(req, campaign._id.toString(), {
      digit: '1',
    } as never);
    expect(pressed1.items).toHaveLength(2);
    const none = await listCampaignContacts(req, campaign._id.toString(), {
      digit: 'none',
    } as never);
    expect(none.items).toHaveLength(1);
  });
});

describe('health facts (IVR-T8)', () => {
  it('counts failed checks of the last hour and uncertain batches older than 30 min', async () => {
    const w = await voiceWorld(storage);
    await AccountModel.updateOne(
      { _id: w.accountId },
      {
        $set: {
          'voiceApi.lastCheck': {
            ok: false,
            reason: 'refused',
            httpStatus: null,
            ivrs: null,
            at: new Date().toISOString(),
          },
        },
      },
    );
    await CampaignModel.collection.insertOne({
      accountId: w.accountId,
      line: 'voice_api',
      voiceApi: {
        batches: [{ no: 1, state: 'uncertain', createdAt: new Date(Date.now() - 3_600_000) }],
      },
    });
    const facts = await readVoiceApiHealth(new Date());
    expect(facts.unreachable1h).toBeGreaterThanOrEqual(1);
    expect(facts.uncertainBatches30m).toBeGreaterThanOrEqual(1);
  });
});
