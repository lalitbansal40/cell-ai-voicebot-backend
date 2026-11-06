import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEnv, resetEnvForTests } from '../../src/config/env';
import { Cell24x7VoiceClient, FakeVoiceClient, setVoiceApiClient } from '../../src/core/voice-api';
import { AccountModel } from '../../src/db/models/account.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { startCampaign } from '../../src/modules/campaigns/campaigns.service';
import { runVoiceBatch } from '../../src/modules/campaigns/voice-api/batch';
import { setVoiceJobs } from '../../src/modules/campaigns/voice-api/jobs';
import {
  forgetVoiceClient,
  voiceCallerIdFor,
  voiceClientFor,
} from '../../src/modules/voice-api/clients';
import { seal, secretBoxKey } from '../../src/shared/crypto/secret-box';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';
import { createVoiceCampaign, voiceWorld } from '../helpers/voice';

/** Per-account Cell24x7 logins: own token + caller ID, own webhook, results kept apart. */

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage });
const prefix = uniquePrefix('vapi-acc');
const saved = process.env.VOICE_API_PROVIDER;
const NOW = new Date('2026-11-05T05:00:00.000Z');
const TOKEN = 'cell24x7-own-token-9876';
let redis: Redis;
let fake: FakeVoiceClient;
let superadmin: TestUser;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const credentials = (id: string, body: object) =>
  request(app)
    .put(`/api/v1/admin/accounts/${id}/voice-api/credentials`)
    .set(header(superadmin))
    .send(body);

beforeAll(async () => {
  process.env.VOICE_API_PROVIDER = 'fake';
  resetEnvForTests();
  redis = (await requireRedis()).client;
  fake = new FakeVoiceClient(redis, { delayMs: 60_000, prefix });
  setVoiceApiClient(fake);
  setVoiceJobs(null);
  await ensureRateCard();
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

afterAll(async () => {
  fake.stop();
  setVoiceApiClient(null);
  if (saved === undefined) delete process.env.VOICE_API_PROVIDER;
  else process.env.VOICE_API_PROVIDER = saved;
  resetEnvForTests();
  await flushPrefix(redis, prefix);
});

describe('an account on its own Cell24x7 token', () => {
  it('a superadmin saves a checked token + caller ID; it is sealed and never shown', async () => {
    const w = await voiceWorld(storage);
    const id = w.accountId.toString();
    expect((await credentials(id, { mode: 'own' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await credentials(id, { mode: 'own', token: TOKEN, callerId: '12345' })).status).toBe(
      422,
    );
    const res = await credentials(id, { mode: 'own', token: TOKEN, callerId: '9876543210' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      mode: 'own',
      tokenHint: '9876',
      callerId: '9876543210',
      webhookRegisteredAt: null,
    });
    expect(res.body.data.verifiedAt).not.toBeNull();
    const row = await AccountModel.findById(w.accountId).lean();
    const stored = JSON.stringify(row?.voiceApi);
    expect(stored).not.toContain(TOKEN);
    expect(row?.voiceApi?.credentials?.tokenSealed).toBeTruthy();
    const detail = await request(app).get(`/api/v1/admin/accounts/${id}`).set(header(superadmin));
    expect(JSON.stringify(detail.body)).not.toContain(TOKEN);
    expect(JSON.stringify(detail.body)).not.toContain('tokenSealed');
    expect(detail.body.data.voiceApi.credentials).toMatchObject({ mode: 'own', tokenHint: '9876' });
    // the other switches keep the credentials
    await request(app)
      .patch(`/api/v1/admin/accounts/${id}/voice-api`)
      .set(header(superadmin))
      .send({ ivrEstimateSec: 45 });
    expect(await voiceCallerIdFor(w.accountId)).toBe('9876543210');
    // back to the platform token
    const back = await credentials(id, { mode: 'platform' });
    expect(back.body.data).toMatchObject({ mode: 'platform', tokenHint: null, callerId: null });
    expect(await voiceCallerIdFor(w.accountId)).toBe(getEnv().CELL24X7_VOICE_CALLER_ID);
  });

  it('campaigns of an own-token account use a client with that token; others the platform one', async () => {
    const platformClient = new Cell24x7VoiceClient({
      baseUrl: 'https://voice.example.test',
      token: 'platform-token',
    });
    setVoiceApiClient(platformClient);
    try {
      const own = await voiceWorld(storage);
      const other = await voiceWorld(storage);
      await AccountModel.updateOne(
        { _id: own.accountId },
        {
          $set: {
            'voiceApi.credentials': {
              mode: 'own',
              tokenSealed: seal(secretBoxKey(getEnv()), TOKEN),
              tokenHint: '9876',
              callerId: null,
              webhookKeyHash: null,
              webhookRegisteredAt: null,
              verifiedAt: new Date(),
            },
          },
        },
      );
      forgetVoiceClient();
      const ownClient = await voiceClientFor(own.accountId);
      expect(ownClient).toBeInstanceOf(Cell24x7VoiceClient);
      expect(ownClient).not.toBe(platformClient);
      expect(await voiceClientFor(own.accountId)).toBe(ownClient); // cached
      expect(await voiceClientFor(other.accountId)).toBe(platformClient);
    } finally {
      setVoiceApiClient(fake);
      forgetVoiceClient();
    }
  });

  it("its own webhook: registered per account; results reach only that account's batch", async () => {
    const w = await voiceWorld(storage, { endings: [1] });
    const id = w.accountId.toString();
    await credentials(id, { mode: 'own', token: TOKEN });
    const reg = await request(app)
      .post(`/api/v1/admin/accounts/${id}/voice-api/webhook`)
      .set(header(superadmin));
    expect(reg.status).toBe(200);
    expect(reg.body.data.webhookRegisteredAt).not.toBeNull();
    const url = (await fake.getWebhook()) as string;
    expect(url).toContain(`/api/v1/webhooks/voice-api/a/${id}/`);
    const key = url.split('/').pop() as string;

    const created = await createVoiceCampaign(w, 'Own login run');
    await startCampaign(w.req, created.id);
    expect(await runVoiceBatch(created.id, { storage, now: () => NOW })).toBe('submitted');
    const campaign = (await CampaignModel.findById(created.id).lean<CampaignDoc>()) as CampaignDoc;
    const requestId = campaign.voiceApi?.batches[0]?.requestId as string;
    const row = await CampaignContactModel.findOne({ campaignId: created.id }).lean();
    const receiver = row?.voiceApi?.receiver10 as string;
    const body = {
      event: 'voice.status.update',
      request_id: requestId,
      receiver,
      status: 'ANSWERED',
      duration: 20,
    };
    // the platform webhook never settles an own-login batch (request ids may repeat)
    await request(app)
      .post(`/api/v1/webhooks/voice-api/${getEnv().CELL24X7_WEBHOOK_SECRET}`)
      .send(body);
    expect((await CampaignContactModel.findById(row?._id).lean())?.status).toBe('calling');
    expect(
      (await request(app).post(`/api/v1/webhooks/voice-api/a/${id}/wrong-key`).send(body)).status,
    ).toBe(404);
    const ok = await request(app).post(`/api/v1/webhooks/voice-api/a/${id}/${key}`).send(body);
    expect(ok.status).toBe(200);
    expect((await CampaignContactModel.findById(row?._id).lean())?.status).toBe('completed');
  });
});
