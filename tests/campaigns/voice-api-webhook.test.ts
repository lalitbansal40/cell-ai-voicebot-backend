import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEnv, resetEnvForTests } from '../../src/config/env';
import { FakeVoiceClient, setVoiceApiClient } from '../../src/core/voice-api';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { startCampaign } from '../../src/modules/campaigns/campaigns.service';
import { runVoiceBatch } from '../../src/modules/campaigns/voice-api/batch';
import { setVoiceJobs } from '../../src/modules/campaigns/voice-api/jobs';
import { pollVoiceCampaign } from '../../src/modules/campaigns/voice-api/results';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';
import { createVoiceCampaign, voiceWorld } from '../helpers/voice';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage });
const prefix = uniquePrefix('vapi-hook');
const saved = process.env.VOICE_API_PROVIDER;
const NOW = new Date('2026-11-05T05:00:00.000Z');
let redis: Redis;
let fake: FakeVoiceClient;
let fakeNow = Date.now();

const hook = (secret: string, body: unknown) =>
  request(app)
    .post(`/api/v1/webhooks/voice-api/${secret}`)
    .send(body as object);
const doc = async (id: string) =>
  (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;

beforeAll(async () => {
  process.env.VOICE_API_PROVIDER = 'fake';
  resetEnvForTests();
  redis = (await requireRedis()).client;
  fake = new FakeVoiceClient(redis, { delayMs: 60_000, prefix, now: () => fakeNow });
  setVoiceApiClient(fake);
  // no queue in this process: results apply inline
  setVoiceJobs(null);
  await ensureRateCard();
});

afterAll(async () => {
  fake.stop();
  setVoiceApiClient(null);
  if (saved === undefined) delete process.env.VOICE_API_PROVIDER;
  else process.env.VOICE_API_PROVIDER = saved;
  resetEnvForTests();
  await flushPrefix(redis, prefix);
});

describe('Cell24x7 result webhook', () => {
  it('needs the secret path, counts each result once and upgrades a later answer', async () => {
    const w = await voiceWorld(storage, { endings: [1, 6] });
    const created = await createVoiceCampaign(w, 'Webhook run');
    await startCampaign(w.req, created.id);
    expect(await runVoiceBatch(created.id, { client: fake, storage, now: () => NOW })).toBe(
      'submitted',
    );
    const requestId = (await doc(created.id)).voiceApi?.batches[0]?.requestId as string;
    const rows = await CampaignContactModel.find({ campaignId: created.id, status: 'calling' })
      .sort({ seq: 1 })
      .lean();
    const [answered, missed] = rows.map((r) => r.voiceApi?.receiver10 as string);
    const secret = getEnv().CELL24X7_WEBHOOK_SECRET;

    expect((await hook('wrong-secret', { request_id: requestId })).status).toBe(404);
    // unknown request / malformed body: acknowledged, ignored
    expect(
      (await hook(secret, { request_id: 'VCAMP_NOPE', receiver: answered, status: 'ANSWERED' }))
        .status,
    ).toBe(200);
    expect((await hook(secret, { hello: 'world' })).status).toBe(200);
    expect((await doc(created.id)).stats.answered).toBe(0);

    const body = (receiver: string, status: string, extra = {}) => ({
      event: 'voice.status.update',
      request_id: requestId,
      receiver,
      status,
      duration: 21,
      ...extra,
    });
    // progress is not final
    await hook(secret, body(answered as string, 'CALLING'));
    expect((await doc(created.id)).stats.calling).toBe(2);
    const first = await hook(
      secret,
      body(answered as string, 'ANSWERED', { ivr: { digits_pressed: '1' } }),
    );
    expect(first.body).toEqual({ success: true, data: { received: true } });
    await hook(secret, body(answered as string, 'ANSWERED'));
    await hook(secret, body(missed as string, 'NO ANSWER', { duration: 0 }));
    let c = await doc(created.id);
    expect(c.stats).toMatchObject({ answered: 1, completed: 1, failed: 1, calling: 0 });
    const row = await CampaignContactModel.findOne({ 'voiceApi.receiver10': answered }).lean();
    expect(row?.voiceApi).toMatchObject({ providerStatus: 'ANSWERED', dtmf: '1', durationSec: 21 });

    // a provider redial reached the missed number: one upgrade, counted once
    await hook(secret, body(missed as string, 'ANSWERED'));
    await hook(secret, body(missed as string, 'ANSWERED'));
    c = await doc(created.id);
    expect(c.stats).toMatchObject({ answered: 2, completed: 2, failed: 0 });
    expect(c.status).toBe('completed');

    // the poller later reads its own (final) view: nothing moves
    fakeNow += 120_000;
    await pollVoiceCampaign(created.id, { client: fake });
    expect((await doc(created.id)).stats).toMatchObject({ answered: 2, completed: 2 });
  });
});
