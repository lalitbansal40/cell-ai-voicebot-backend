import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnv, resetEnvForTests } from '../../src/config/env';
import { VOICE_API_CONFIG } from '../../src/config/voice-api';
import { closeAllRedis } from '../../src/core/queues/redis';
import {
  Cell24x7VoiceClient,
  getVoiceApiClient,
  setVoiceApiClient,
} from '../../src/core/voice-api';
import { AccountModel } from '../../src/db/models/account.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { createCampaign, startCampaign } from '../../src/modules/campaigns/campaigns.service';
import { runVoiceBatch } from '../../src/modules/campaigns/voice-api/batch';
import { setVoiceJobs } from '../../src/modules/campaigns/voice-api/jobs';
import { pollVoiceCampaign } from '../../src/modules/campaigns/voice-api/results';
import { voiceRunProblems } from '../../src/modules/campaigns/voice-api/settings';
import { forgetVoiceClient, voiceClientFor } from '../../src/modules/voice-api/clients';
import { accountVoiceApi } from '../../src/modules/voice-api/voice-api.service';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard } from '../helpers/calls';
import { ALL_DAY } from '../helpers/campaigns';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';
import { createVoiceCampaign, voiceWorld } from '../helpers/voice';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage });
const TOKEN = 'dashboard-only-test-key-9876';
const ENV_KEYS = [
  'VOICE_API_PROVIDER',
  'CELL24X7_VOICE_BASE_URL',
  'CELL24X7_VOICE_API_TOKEN',
  'CELL24X7_VOICE_CALLER_ID',
  'CELL24X7_WEBHOOK_SECRET',
  'VOICE_API_BATCH_SIZE',
  'VOICE_API_LINES',
  'VOICE_API_POLL_SEC',
  'VOICE_API_FAKE_DELAY_MS',
] as const;
let superadmin: TestUser;
let webhookUrl = '';
let numbers: string[] = [];

// Mock only the external provider; requests still use the real client, routes, MongoDB and billing.
const providerFetch = vi.fn<typeof fetch>();
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
const headers = () => ({ Authorization: `Bearer ${superadmin.token}` });
const saveKey = (id: string, token = TOKEN) =>
  request(app)
    .put(`/api/v1/admin/accounts/${id}/voice-api/credentials`)
    .set(headers())
    .send({ mode: 'own', token });

beforeAll(async () => {
  await ensureRateCard();
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  resetEnvForTests();
  setVoiceApiClient(null);
  setVoiceJobs(null);
  forgetVoiceClient();
  webhookUrl = '';
  numbers = [];
  providerFetch.mockReset();
  providerFetch.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin + url.pathname.replace(/\/(ivrs|webhook|submit|details)$/, '')).toBe(
      VOICE_API_CONFIG.baseUrl,
    );
    const token = new Headers(init?.headers).get('authorization');
    if (token !== `Bearer ${TOKEN}`) return reply(null, 401);
    if (url.pathname.endsWith('/ivrs'))
      return reply([{ id: 101, name: 'Account menu', runnable: true }]);
    if (url.pathname.endsWith('/webhook')) {
      expect(typeof init?.body).toBe('string');
      webhookUrl = (JSON.parse(init?.body as string) as { url: string }).url;
      return reply({ url: webhookUrl });
    }
    if (url.pathname.endsWith('/submit')) {
      const csv = (init?.body as FormData).get('csv_file') as Blob;
      numbers = (await csv.text()).trim().split('\n').slice(1);
      return reply({ request_id: 'VCAMP_DASHBOARD_ONLY', contacts: numbers.length }, 201);
    }
    if (url.pathname.endsWith('/details'))
      return reply(numbers.map((receiver) => ({ receiver, status: 'ANSWERED', duration: 20 })));
    throw new Error('Unexpected provider request');
  });
  vi.stubGlobal('fetch', providerFetch);
});

afterEach(async () => {
  forgetVoiceClient();
  setVoiceApiClient(null);
  setVoiceJobs(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvForTests();
  await closeAllRedis();
});

describe('dashboard Cell24x7 keys without voice environment settings', () => {
  it('connects, generates an account webhook, and runs and polls an own-token campaign', async () => {
    expect(getEnv().VOICE_API_PROVIDER).toBe('off');
    expect(getEnv().CELL24X7_VOICE_API_TOKEN).toBeUndefined();
    expect(getEnv().CELL24X7_WEBHOOK_SECRET).toBe('');
    expect(getVoiceApiClient()).toBeNull();
    const w = await voiceWorld(storage, { endings: [1] });
    const id = w.accountId.toString();
    expect((await accountVoiceApi(id)).enabled).toBe(false);
    const saved = await saveKey(id);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ mode: 'own', tokenHint: '9876' });
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
    const account = await AccountModel.findById(id).lean();
    expect(account?.voiceApi?.credentials?.tokenSealed).toBeTruthy();
    expect(JSON.stringify(account?.voiceApi)).not.toContain(TOKEN);
    expect((await accountVoiceApi(id)).enabled).toBe(true);
    expect(await voiceClientFor(id)).toBeInstanceOf(Cell24x7VoiceClient);
    // Another enabled account without a key never uses this account's credentials.
    const other = await createTestAccount({
      voiceApi: { enabled: true, ivrIds: [], ivrEstimateSec: 60 },
    });
    expect((await accountVoiceApi(other.account._id)).enabled).toBe(false);
    expect(await voiceClientFor(other.account._id)).toBeNull();

    const registered = await request(app)
      .post(`/api/v1/admin/accounts/${id}/voice-api/webhook`)
      .set(headers());
    expect(registered.status).toBe(200);
    expect(registered.body.data.webhookRegisteredAt).not.toBeNull();
    const path = new URL(webhookUrl).pathname;
    expect(path).toMatch(new RegExp(`^/api/v1/webhooks/voice-api/a/${id}/[A-Za-z0-9_-]{32}$`));
    expect((await request(app).post(path).send({})).status).toBe(200);
    expect(
      (await request(app).post(`/api/v1/webhooks/voice-api/a/${id}/wrong`).send({})).status,
    ).toBe(404);

    const created = await createVoiceCampaign(w, 'Dashboard key campaign');
    await startCampaign(w.req, created.id);
    expect(
      await runVoiceBatch(created.id, { storage, now: () => new Date('2026-11-05T05:00:00Z') }),
    ).toBe('submitted');
    expect(numbers).toHaveLength(1);
    expect(await pollVoiceCampaign(created.id)).toMatchObject({ batches: 1, rows: 1 });
    const campaign = await CampaignModel.findById(created.id).lean<CampaignDoc>();
    expect(campaign).toMatchObject({ status: 'completed', stats: { answered: 1, completed: 1 } });
  });

  it('refuses invalid keys before saving credentials and reports account-key support in status', async () => {
    const account = await createTestAccount();
    const id = account.account._id.toString();
    const refused = await saveKey(id, 'invalid-dashboard-key');
    expect(refused.body.error.code).toBe('VOICE_API_AUTH');
    expect(
      (await AccountModel.findById(id).lean())?.voiceApi?.credentials?.tokenSealed,
    ).toBeFalsy();
    expect((await accountVoiceApi(id)).enabled).toBe(false);
    const status = await request(app).get('/api/v1/admin/voice-api/status').set(headers());
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ provider: 'cell24x7', tokenConfigured: false });
  });

  it('lets an own-token account use its runnable IVRs without platform assignments', async () => {
    const w = await voiceWorld(storage, { endings: [1] });
    await AccountModel.updateOne({ _id: w.accountId }, { $set: { 'voiceApi.ivrIds': [] } });
    expect((await saveKey(w.accountId.toString())).status).toBe(200);
    const created = await createCampaign(w.req, {
      name: 'Own IVR without env',
      line: 'voice_api',
      mode: 'live',
      voiceApi: { content: { kind: 'ivr', ivrId: 101 }, retries: 0, retryIntervalMin: 30 },
      audience: { contactIds: w.contactIds },
      window: ALL_DAY,
    });
    const campaign = await CampaignModel.findById(created.id).lean<CampaignDoc>();
    expect(campaign).not.toBeNull();
    expect(await voiceRunProblems(campaign as CampaignDoc)).toEqual([]);
  });
});
