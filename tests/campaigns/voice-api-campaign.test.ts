import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetEnvForTests } from '../../src/config/env';
import { getOrCreateWallet } from '../../src/core/billing/wallets';
import { FakeVoiceClient, setVoiceApiClient } from '../../src/core/voice-api';
import { MIGRATIONS } from '../../src/db/migrations';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import {
  cancelCampaign,
  estimateCampaignCost,
  resumeCampaign,
  startCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { runVoiceBatch, resolveVoiceBatch } from '../../src/modules/campaigns/voice-api/batch';
import { setVoiceJobs } from '../../src/modules/campaigns/voice-api/jobs';
import { pollVoiceCampaign } from '../../src/modules/campaigns/voice-api/results';
import { ensureRateCard } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { createVoiceCampaign, voiceWorld } from '../helpers/voice';

useTestDb();
const storage = useTempStorage();
const prefix = uniquePrefix('vapi');
const ENV_KEYS = ['VOICE_API_PROVIDER', 'VOICE_API_BATCH_SIZE'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// inside the TRAI window (10:30 IST) so batches may go out whatever the test clock says
const NOW = new Date('2026-11-05T05:00:00.000Z');
let redis: Redis;
let fake: FakeVoiceClient;
let fakeNow = Date.now();

const doc = async (id: string) =>
  (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;
const batchOf = (id: string) => runVoiceBatch(id, { client: fake, storage, now: () => NOW });
const finishFake = () => {
  fakeNow += 120_000;
};

beforeAll(async () => {
  process.env.VOICE_API_PROVIDER = 'fake';
  process.env.VOICE_API_BATCH_SIZE = '3';
  resetEnvForTests();
  redis = (await requireRedis()).client;
  fake = new FakeVoiceClient(redis, { delayMs: 60_000, prefix, now: () => fakeNow });
  setVoiceApiClient(fake);
  setVoiceJobs(null);
  await ensureRateCard();
});

afterAll(async () => {
  fake.stop();
  setVoiceApiClient(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetEnvForTests();
  await flushPrefix(redis, prefix);
});

describe('recorded-voice campaigns (Cell24x7)', () => {
  it('estimates, sends safe batches, applies results and completes', async () => {
    const w = await voiceWorld(storage);
    const created = await createVoiceCampaign(w, 'Reminder run');
    expect(created).toMatchObject({ line: 'voice_api', mode: 'live', flow: { id: '' } });
    expect(created.voiceApi).toMatchObject({ audioSec: 24, retries: 0, batches: [] });

    const estimate = await estimateCampaignCost(w.req, created.id);
    // 5 mobiles (the landline is skipped), 24 s = 2 pulses × ₹0.50
    expect(estimate).toMatchObject({
      contacts: 5,
      perCallMicros: 1_000_000,
      totalMicros: 5_000_000,
    });
    expect(estimate).toMatchObject({
      voice: {
        pulsesPerNumber: 2,
        notPriced: false,
        notIndianMobile: 1,
      },
    });

    const started = await startCampaign(w.req, created.id);
    expect(started.status).toBe('running');
    expect(started.stats.skippedBy.not_indian_mobile).toBe(1);

    expect(await batchOf(created.id)).toBe('submitted');
    const first = fake.submits.at(-1);
    expect(first?.audio.kind).toBe('file');
    expect(first?.numbers).toHaveLength(3);
    expect(first?.broadcastName).toBe(`cav-${created.id}-1`);
    let c = await doc(created.id);
    expect(c.voiceApi?.batches[0]).toMatchObject({
      no: 1,
      state: 'open',
      count: 3,
      amountMicros: 3_000_000,
    });
    expect(c.stats).toMatchObject({ calling: 3, pending: 2, spentMicros: 3_000_000 });
    const audio = await FlowAudioModel.findById(w.audioId).lean();
    expect(audio?.providerFiles?.cell24x7?.audioFileId).toBeGreaterThan(0);
    // the batch's numbers are still dialing: the next one waits (Stop can hold it back)
    expect(await batchOf(created.id)).toBe('gated');

    finishFake();
    expect((await pollVoiceCampaign(created.id, { client: fake })).rows).toBe(3);
    c = await doc(created.id);
    expect(c.voiceApi?.batches[0]?.state).toBe('done');
    expect(await batchOf(created.id)).toBe('submitted');
    expect(fake.submits.at(-1)?.audio.kind).toBe('audio_id');

    finishFake();
    await pollVoiceCampaign(created.id, { client: fake });
    c = await doc(created.id);
    expect(c.status).toBe('completed');
    // endings 1, 2 answered; 6 no answer; 8 busy; 9 failed
    expect(c.stats).toMatchObject({
      completed: 2,
      failed: 3,
      answered: 2,
      calling: 0,
      attempts: 5,
    });
    expect(c.stats.spentMicros).toBe(5_000_000);

    const calls = await CallModel.find({ campaignId: c._id }).lean();
    expect(calls.map((x) => x.provider)).toEqual(Array(5).fill('voice_api'));
    expect(calls.filter((x) => x.status === 'completed')).toHaveLength(2);
    expect(calls.every((x) => x.insights?.status === 'skipped')).toBe(true);
    const ledger = await LedgerEntryModel.find({
      accountId: w.accountId,
      type: 'voice_broadcast_charge',
      status: 'captured',
    }).lean();
    expect(ledger.map((e) => e.amountMicros).sort()).toEqual([2_000_000, 3_000_000]);
    expect((await getOrCreateWallet(w.accountId)).holdMicros).toBe(0);
    // a later poll repeats final rows: counters do not move
    await pollVoiceCampaign(created.id, { client: fake });
    expect((await doc(created.id)).stats.answered).toBe(2);
  });

  it('stops between batches: unsent numbers are canceled and never submitted', async () => {
    const w = await voiceWorld(storage);
    const created = await createVoiceCampaign(w, 'Stop me');
    await startCampaign(w.req, created.id);
    const before = fake.submits.length;
    expect(await batchOf(created.id)).toBe('submitted');
    await cancelCampaign(w.req, created.id, false);
    expect(await batchOf(created.id)).toBe('not_running');
    expect(fake.submits.length).toBe(before + 1);
    const pending = await CampaignContactModel.countDocuments({
      campaignId: created.id,
      status: 'canceled',
    });
    expect(pending).toBe(2);
  });

  it('a refused submit (402) gives money and numbers back and pauses', async () => {
    const w = await voiceWorld(storage);
    const created = await createVoiceCampaign(w, 'No credits');
    await startCampaign(w.req, created.id);
    fake.failNext('402');
    expect(await batchOf(created.id)).toBe('paused');
    const c = await doc(created.id);
    expect(c).toMatchObject({ status: 'paused', pauseReason: 'provider_error' });
    expect(c.voiceApi?.lastError?.code).toBe('VOICE_API_NO_CREDITS');
    expect(c.voiceApi?.batches[0]?.state).toBe('failed');
    expect(c.stats).toMatchObject({ pending: 5, queued: 0, calling: 0, spentMicros: 0 });
    expect((await getOrCreateWallet(w.accountId)).holdMicros).toBe(0);
  });

  it('an unanswered submit is uncertain: never resent; resolving it releases the hold', async () => {
    const w = await voiceWorld(storage);
    const created = await createVoiceCampaign(w, 'Timeout');
    await startCampaign(w.req, created.id);
    const before = fake.submits.length;
    fake.failNext('timeout');
    expect(await batchOf(created.id)).toBe('paused');
    let c = await doc(created.id);
    expect(c.pauseReason).toBe('provider_uncertain');
    expect(c.voiceApi?.batches[0]?.state).toBe('uncertain');
    expect((await getOrCreateWallet(w.accountId)).holdMicros).toBe(3_000_000);
    await expect(resumeCampaign(w.req, created.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    // even if it were running again, the uncertain batch blocks any new submit
    await CampaignModel.updateOne({ _id: created.id }, { $set: { status: 'running' } });
    expect(await batchOf(created.id)).toBe('blocked');
    expect(fake.submits.length).toBe(before);

    await resolveVoiceBatch(created.id, 1, { outcome: 'not_submitted' });
    c = await doc(created.id);
    expect(c.voiceApi?.batches[0]?.state).toBe('failed');
    expect(c.stats).toMatchObject({ pending: 5, queued: 0 });
    expect((await getOrCreateWallet(w.accountId)).holdMicros).toBe(0);
  });

  it('refuses unpriced or disabled accounts and keeps phone dialing away', async () => {
    const unpriced = await voiceWorld(storage, { priced: false });
    const c1 = await createVoiceCampaign(unpriced, 'No price');
    await expect(startCampaign(unpriced.req, c1.id)).rejects.toMatchObject({
      code: 'VOICE_API_NOT_PRICED',
    });
    const off = await voiceWorld(storage, { enabled: false });
    await expect(createVoiceCampaign(off, 'Off')).rejects.toMatchObject({
      code: 'VOICE_API_NOT_ENABLED',
    });
    // no call of any other provider was made by voice campaigns
    expect(await CallModel.countDocuments({ provider: { $ne: 'voice_api' } })).toBe(0);
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0025-voice-api')).toBe(names.indexOf('0024-whatsapp-call-campaigns') + 1);
    expect(new Types.ObjectId()).toBeTruthy();
  });
});
