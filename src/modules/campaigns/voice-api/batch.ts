import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Types } from 'mongoose';

import { getEnv } from '../../../config/env';
import { captureVoiceApi, holdForVoiceApi, releaseVoiceApi } from '../../../core/billing/engine';
import { getAppRedis } from '../../../core/queues/redis';
import type { StorageProvider } from '../../../core/storage';
import { getVoiceApiClient } from '../../../core/voice-api';
import {
  VoiceApiError,
  type VoiceApiAudio,
  type VoiceApiClient,
  type VoiceApiRetryInterval,
} from '../../../core/voice-api/types';
import {
  CampaignContactModel,
  type CampaignContactDoc,
} from '../../../db/models/campaign-contact.model';
import {
  CampaignModel,
  type CampaignDoc,
  type VoiceBatch,
} from '../../../db/models/campaign.model';
import { FlowAudioModel, type FlowAudioDoc } from '../../../db/models/flow-audio.model';
import { AppError } from '../../../shared/errors/app-error';
import { getLogger } from '../../../shared/logger';
import { recordProviderError } from '../../voice-api/status';
import { accountFacts, pauseCampaignDoc } from '../campaigns.service';
import { completeIfDone } from '../dispatcher';
import { publishProgress } from '../progress';
import { canDialAt, effectiveWindow, nextWindowStart, toMinutes } from '../window';

import { getVoiceJobs } from './jobs';
import { voiceEtaSec, voicePrice, voiceRunProblems } from './settings';

/**
 * VAPI batch loop (one tick per job, under a Redis lock per campaign): claim the next
 * numbers → hold the wallet → submit to Cell24x7 → capture. A submit without a clear
 * answer is `uncertain` and never repeated; a superadmin resolves it.
 */

export type BatchTick =
  'not_running' | 'busy' | 'blocked' | 'window' | 'gated' | 'empty' | 'submitted' | 'paused';

export interface BatchDeps {
  client?: VoiceApiClient | null;
  storage?: StorageProvider | undefined;
  now?: () => Date;
}

/** A batch waits until fewer than this share of the open numbers are still dialing. */
export const OPEN_SHARE_TO_CONTINUE = 0.2;
const LOCK_MS = 120_000;
const NEXT_BATCH_DELAY_MS = 30_000;

let defaultStorage: StorageProvider | undefined;
/** The worker's file storage (audio uploads). */
export const setVoiceStorage = (storage: StorageProvider | undefined): void => {
  defaultStorage = storage;
};

const redis = () => getAppRedis(getEnv().REDIS_URL, getLogger());

const withLock = async <T>(campaignId: string, fn: () => Promise<T>): Promise<T | 'busy'> => {
  const key = `vapi-lock:${campaignId}`;
  const token = randomUUID();
  const got = await redis().set(key, token, 'PX', LOCK_MS, 'NX');
  if (got !== 'OK') return 'busy';
  try {
    return await fn();
  } finally {
    // release only our own lock
    await redis()
      .eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        key,
        token,
      )
      .catch(() => undefined);
  }
};

const setBatch = (campaignId: Types.ObjectId, no: number, set: Partial<VoiceBatch>) =>
  CampaignModel.updateOne(
    { _id: campaignId, 'voiceApi.batches.no': no },
    {
      $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`voiceApi.batches.$.${k}`, v])),
    },
  );

const bufferOf = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
};

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg' } as const;

/** Audio for the submit: the cached Cell24x7 id, else the file itself. */
const audioFor = async (
  campaign: CampaignDoc,
  storage: StorageProvider | undefined,
  useCache: boolean,
): Promise<{ audio: VoiceApiAudio; audioDoc: FlowAudioDoc | null }> => {
  const content = campaign.voiceApi?.content;
  if (!content) throw new AppError('VOICE_API_AUDIO_INVALID');
  if (content.kind === 'ivr') return { audio: { kind: 'ivr', id: content.ivrId }, audioDoc: null };
  const audioDoc = await FlowAudioModel.findOne({
    _id: content.flowAudioId,
    accountId: campaign.accountId,
  }).lean<FlowAudioDoc>();
  if (!audioDoc) throw new AppError('VOICE_API_AUDIO_INVALID');
  const cached = audioDoc.providerFiles?.cell24x7?.audioFileId;
  if (useCache && cached) return { audio: { kind: 'audio_id', id: cached }, audioDoc };
  if (!storage) throw new AppError('VOICE_API_AUDIO_INVALID', 'Audio storage is not available.');
  const data = await bufferOf(await storage.get(audioDoc.fileKey));
  return {
    audio: {
      kind: 'file',
      data,
      filename: `audio-${audioDoc._id.toString()}.${audioDoc.format}`,
      mime: MIME[audioDoc.format],
    },
    audioDoc,
  };
};

/** Puts claimed-but-unsent numbers of a batch back (pending) or ends them (canceled). */
const releaseClaims = async (
  campaign: CampaignDoc,
  batchNo: number,
  to: 'pending' | 'canceled',
): Promise<number> => {
  const rows = await CampaignContactModel.find({
    campaignId: campaign._id,
    status: 'queued',
    'voiceApi.batchNo': batchNo,
  })
    .select({ _id: 1 })
    .lean();
  if (!rows.length) return 0;
  const moved = await CampaignContactModel.updateMany(
    { _id: { $in: rows.map((r) => r._id) }, status: 'queued' },
    {
      $set: {
        status: to,
        voiceApi: null,
        claimToken: null,
        claimedAt: null,
        nextAttemptAt: to === 'pending' ? new Date() : null,
      },
    },
  );
  if (moved.modifiedCount) {
    await CampaignModel.updateOne(
      { _id: campaign._id },
      {
        $inc: {
          'stats.queued': -moved.modifiedCount,
          [to === 'pending' ? 'stats.pending' : 'stats.canceled']: moved.modifiedCount,
        },
      },
    );
  }
  return moved.modifiedCount;
};

/** A batch that never reached the provider goes away: money back, numbers back. */
const dropBatch = async (
  campaign: CampaignDoc,
  batch: VoiceBatch,
  reason: string,
  numbersTo: 'pending' | 'canceled',
): Promise<void> => {
  if (batch.holdId) {
    await releaseVoiceApi({ accountId: campaign.accountId, holdId: batch.holdId, reason });
  }
  await releaseClaims(campaign, batch.no, numbersTo);
  await setBatch(campaign._id, batch.no, { state: 'failed', error: reason });
};

/** Pauses with a provider reason and remembers the error. */
const pauseFor = async (
  campaign: CampaignDoc,
  reason: 'provider_error' | 'provider_uncertain' | 'wallet_empty',
  code: string | null,
): Promise<void> => {
  if (code) {
    await CampaignModel.updateOne(
      { _id: campaign._id },
      { $set: { 'voiceApi.lastError': { code, at: new Date() } } },
    );
  }
  const fresh = await CampaignModel.findById(campaign._id).lean<CampaignDoc>();
  if (fresh?.status === 'running')
    await pauseCampaignDoc(fresh, reason, null).catch(() => undefined);
};

/** Cell24x7 refused our login / credits: every running voice campaign pauses. */
const pauseAllVoice = async (code: string): Promise<void> => {
  await recordProviderError(code);
  const running = await CampaignModel.find({ line: 'voice_api', status: 'running' }).lean<
    CampaignDoc[]
  >();
  for (const c of running) await pauseFor(c, 'provider_error', code);
};

/** Window + redials must end inside the effective window (TRAI 09:00–21:00 included). */
const windowAllows = async (
  campaign: CampaignDoc,
  now: Date,
  count: number,
): Promise<{ ok: true } | { ok: false; next: Date | null }> => {
  const account = await accountFacts(campaign.accountId);
  const w = effectiveWindow({
    account: account.window,
    campaign: campaign.window,
    live: true,
    recovery: false,
  });
  const tz = campaign.schedule.timezone;
  if (!w || !canDialAt(now, w, tz))
    return { ok: false, next: w ? nextWindowStart(now, w, tz) : null };
  const v = campaign.voiceApi;
  const needMin =
    voiceEtaSec(count, v?.audioSec ?? 60) / 60 + (v?.retries ?? 0) * (v?.retryIntervalMin ?? 0);
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const left = toMinutes(w.end) - toMinutes(local);
  // a batch that cannot finish today waits for the next window (a small batch still goes)
  if (left < needMin && count > 1)
    return {
      ok: false,
      next: nextWindowStart(new Date(now.getTime() + left * 60_000 + 60_000), w, tz),
    };
  return { ok: true };
};

/** One batch tick for a campaign (job `voice.batch`, the sweep and resume call it). */
export const runVoiceBatch = async (
  campaignId: string,
  deps: BatchDeps = {},
): Promise<BatchTick> => {
  const result = await withLock(campaignId, () => tick(campaignId, deps));
  return result;
};

const tick = async (campaignId: string, deps: BatchDeps): Promise<BatchTick> => {
  const now = deps.now?.() ?? new Date();
  const client = deps.client === undefined ? getVoiceApiClient() : deps.client;
  let campaign = await CampaignModel.findById(campaignId).lean<CampaignDoc>();
  if (!campaign || campaign.line !== 'voice_api' || !campaign.voiceApi) return 'not_running';
  const batches = campaign.voiceApi.batches;
  // a batch held but never submitted (crash, pause, stop): give it back first
  const holding = batches.find((b) => b.state === 'holding');
  if (campaign.status !== 'running') {
    if (holding) {
      await dropBatch(
        campaign,
        holding,
        'not_submitted',
        campaign.status === 'paused' ? 'pending' : 'canceled',
      );
    }
    return 'not_running';
  }
  if (batches.some((b) => b.state === 'uncertain' || b.state === 'submitting')) {
    // `submitting` after a crash: the provider may have it — never send it again
    for (const b of batches.filter((x) => x.state === 'submitting')) {
      await setBatch(campaign._id, b.no, { state: 'uncertain', error: 'VOICE_API_UNAVAILABLE' });
    }
    await pauseFor(campaign, 'provider_uncertain', 'VOICE_API_UNAVAILABLE');
    return 'blocked';
  }
  if (!client) {
    await pauseFor(campaign, 'provider_error', 'VOICE_API_NOT_ENABLED');
    return 'paused';
  }
  const problems = await voiceRunProblems(campaign);
  if (problems.length) {
    if (holding) await dropBatch(campaign, holding, 'not_runnable', 'pending');
    await pauseFor(campaign, 'provider_error', 'VOICE_API_NOT_ENABLED');
    return 'paused';
  }
  const size = getEnv().VOICE_API_BATCH_SIZE;

  let batch = holding ?? null;
  if (!batch) {
    // gate: the previous batches are mostly done (so Stop can still hold back numbers)
    const open = batches.filter((b) => b.state === 'open');
    if (open.length) {
      const openCount = open.reduce((n, b) => n + b.count, 0);
      const dialing = await CampaignContactModel.countDocuments({
        campaignId: campaign._id,
        status: 'calling',
        'voiceApi.batchNo': { $in: open.map((b) => b.no) },
      });
      if (dialing > openCount * OPEN_SHARE_TO_CONTINUE) return 'gated';
    }
    const pending = await CampaignContactModel.find({
      campaignId: campaign._id,
      accountId: campaign.accountId,
      status: 'pending',
    })
      .sort({ seq: 1 })
      .limit(size)
      .select({ _id: 1, phoneE164: 1 })
      .lean<Pick<CampaignContactDoc, '_id' | 'phoneE164'>[]>();
    if (!pending.length) {
      await completeIfDone(campaign);
      return 'empty';
    }
    const window = await windowAllows(campaign, now, pending.length);
    if (!window.ok) {
      await CampaignModel.updateOne(
        { _id: campaign._id, status: 'running' },
        { $set: { waitingUntil: window.next } },
      );
      return 'window';
    }
    const price = await voicePrice(campaign.accountId, campaign.voiceApi.audioSec);
    if (price.notPriced) {
      await pauseFor(campaign, 'provider_error', 'VOICE_API_NOT_PRICED');
      return 'paused';
    }
    // claim the numbers and open the batch in one place (compare-and-set on nextBatchNo)
    const no = campaign.voiceApi.nextBatchNo;
    const opened = await CampaignModel.findOneAndUpdate(
      { _id: campaign._id, status: 'running', 'voiceApi.nextBatchNo': no },
      {
        $inc: { 'voiceApi.nextBatchNo': 1 },
        $set: { waitingUntil: null },
        $push: {
          'voiceApi.batches': {
            no,
            state: 'holding',
            requestId: null,
            count: 0,
            holdId: null,
            amountMicros: 0,
            createdAt: now,
            submittedAt: null,
            doneAt: null,
            lastPolledAt: null,
            error: null,
          } satisfies VoiceBatch,
        },
      },
      { returnDocument: 'after' },
    ).lean<CampaignDoc>();
    if (!opened) return 'busy';
    campaign = opened;
    const claimedAt = new Date();
    const ops = pending.flatMap((cc) => {
      const receiver10 = /^\+91(\d{10})$/.exec(cc.phoneE164)?.[1];
      if (!receiver10) return [];
      return [
        {
          updateOne: {
            filter: { _id: cc._id, status: 'pending' as const },
            update: {
              $set: {
                status: 'queued' as const,
                claimedAt,
                nextAttemptAt: null,
                voiceApi: {
                  batchNo: no,
                  requestId: null,
                  receiver10,
                  providerStatus: null,
                  durationSec: 0,
                  dtmf: null,
                  ivrDisposition: null,
                  retryCount: 0,
                  finalAt: null,
                },
              },
            },
          },
        },
      ];
    });
    const claimed = ops.length
      ? (await CampaignContactModel.bulkWrite(ops, { ordered: false })).modifiedCount
      : 0;
    if (claimed) {
      await CampaignModel.updateOne(
        { _id: campaign._id },
        { $inc: { 'stats.pending': -claimed, 'stats.queued': claimed } },
      );
    }
    const amountMicros = claimed * price.perNumberMicros;
    await setBatch(campaign._id, no, { count: claimed, amountMicros });
    batch = {
      no,
      state: 'holding',
      requestId: null,
      count: claimed,
      holdId: null,
      amountMicros,
      createdAt: now,
      submittedAt: null,
      doneAt: null,
      lastPolledAt: null,
      error: null,
    };
    if (!claimed) {
      await setBatch(campaign._id, no, { state: 'failed', error: 'empty' });
      return 'empty';
    }
    try {
      const held = await holdForVoiceApi({
        accountId: campaign.accountId,
        campaignId: campaign._id.toString(),
        batchNo: no,
        amountMicros,
        breakdown: {
          vaNumbers: claimed,
          vaPulses: price.pulsesPerNumber,
          pulseSeconds: 15,
          billableSeconds: price.pulsesPerNumber * 15,
          telephonyMicros: amountMicros,
        },
      });
      const holdId = held.entries[0]?._id ?? null;
      batch.holdId = holdId;
      await setBatch(campaign._id, no, { holdId });
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === 'WALLET_INSUFFICIENT_BALANCE' || err.code === 'WALLET_BUDGET_EXCEEDED')
      ) {
        await dropBatch(campaign, batch, 'wallet_empty', 'pending');
        await pauseFor(campaign, 'wallet_empty', null);
        return 'paused';
      }
      throw err;
    }
  }

  // ── submit (from here on, a crash means "uncertain": never sent twice) ──
  const fresh = await CampaignModel.findById(campaign._id).lean<CampaignDoc>();
  if (!fresh || fresh.status !== 'running') {
    if (fresh)
      await dropBatch(
        fresh,
        batch,
        'not_submitted',
        fresh.status === 'paused' ? 'pending' : 'canceled',
      );
    return 'not_running';
  }
  campaign = fresh;
  const numbers = (
    await CampaignContactModel.find({
      campaignId: campaign._id,
      status: 'queued',
      'voiceApi.batchNo': batch.no,
    })
      .select({ 'voiceApi.receiver10': 1 })
      .lean<{ voiceApi: { receiver10: string } }[]>()
  ).map((r) => r.voiceApi.receiver10);
  const unique = [...new Set(numbers)];
  if (!unique.length) {
    await dropBatch(campaign, batch, 'empty', 'pending');
    return 'empty';
  }
  const v = campaign.voiceApi as NonNullable<CampaignDoc['voiceApi']>;
  const storage = deps.storage ?? defaultStorage;
  const marked = await CampaignModel.updateOne(
    { _id: campaign._id, 'voiceApi.batches': { $elemMatch: { no: batch.no, state: 'holding' } } },
    { $set: { 'voiceApi.batches.$.state': 'submitting' } },
  );
  if (!marked.modifiedCount) return 'busy';
  const submit = async (useCache: boolean) => {
    const { audio, audioDoc } = await audioFor(campaign, storage, useCache);
    const answer = await client.submit({
      broadcastName: `cav-${campaignId}-${String(batch.no)}`,
      callerId: getEnv().CELL24X7_VOICE_CALLER_ID,
      numbers: unique,
      audio,
      retries: v.retries,
      retryIntervalMin: v.retryIntervalMin as VoiceApiRetryInterval,
    });
    if (audioDoc && answer.audioFileId && audio.kind === 'file') {
      await FlowAudioModel.updateOne(
        { _id: audioDoc._id, accountId: campaign?.accountId },
        {
          $set: {
            'providerFiles.cell24x7': { audioFileId: answer.audioFileId, uploadedAt: new Date() },
          },
        },
      );
    }
    return answer;
  };
  let answer;
  try {
    try {
      answer = await submit(true);
    } catch (err) {
      // a cached audio id unknown at Cell24x7 (nothing was created): once more with the file
      if (!(err instanceof VoiceApiError && err.code === 'VOICE_API_NOT_FOUND')) throw err;
      if (v.content?.kind !== 'audio') throw err;
      await FlowAudioModel.updateOne(
        { _id: v.content.flowAudioId, accountId: campaign.accountId },
        { $set: { 'providerFiles.cell24x7': null } },
      );
      answer = await submit(false);
    }
  } catch (err) {
    return submitFailed(campaign, batch, err);
  }

  // ── accepted: numbers dialing, money captured ──
  const submittedAt = new Date();
  await setBatch(campaign._id, batch.no, {
    state: 'open',
    requestId: answer.requestId,
    submittedAt,
  });
  const moved = await CampaignContactModel.updateMany(
    { campaignId: campaign._id, status: 'queued', 'voiceApi.batchNo': batch.no },
    {
      $set: {
        status: 'calling',
        'voiceApi.requestId': answer.requestId,
        lastAttemptAt: submittedAt,
        claimedAt: null,
      },
      $inc: { attempts: 1, dials: 1 },
    },
  );
  if (batch.holdId) {
    await captureVoiceApi({
      accountId: campaign.accountId,
      holdId: batch.holdId,
      campaignId: campaignId,
      batchNo: batch.no,
    });
  }
  await CampaignModel.updateOne(
    { _id: campaign._id },
    {
      $inc: {
        'stats.queued': -moved.modifiedCount,
        'stats.calling': moved.modifiedCount,
        'stats.attempts': moved.modifiedCount,
        'stats.spentMicros': batch.amountMicros,
      },
    },
  );
  publishProgress(campaignId);
  const jobs = getVoiceJobs();
  await jobs?.poll(campaignId, getEnv().VOICE_API_POLL_SEC * 1000);
  await jobs?.batch(campaignId, NEXT_BATCH_DELAY_MS);
  return 'submitted';
};

/** The submit failed: definite refusals give everything back; no answer → uncertain. */
const submitFailed = async (
  campaign: CampaignDoc,
  batch: VoiceBatch,
  err: unknown,
): Promise<BatchTick> => {
  const voiceErr = err instanceof VoiceApiError ? err : null;
  const log = getLogger();
  log.warn(
    {
      campaignId: campaign._id.toString(),
      batchNo: batch.no,
      code: voiceErr?.code ?? (err instanceof AppError ? err.code : 'unknown'),
    },
    'voice api: submit failed',
  );
  if (!voiceErr || voiceErr.uncertain) {
    // our own error before the request left (no file, bad audio) is definite too
    if (!voiceErr && err instanceof AppError) {
      await dropBatch(campaign, batch, err.code, 'pending');
      await pauseFor(campaign, 'provider_error', err.code);
      return 'paused';
    }
    await setBatch(campaign._id, batch.no, { state: 'uncertain', error: 'VOICE_API_UNAVAILABLE' });
    await recordProviderError('VOICE_API_UNAVAILABLE');
    await pauseFor(campaign, 'provider_uncertain', 'VOICE_API_UNAVAILABLE');
    return 'paused';
  }
  const code = voiceErr.code === 'VOICE_API_NOT_FOUND' ? 'VOICE_API_IVR_MISSING' : voiceErr.code;
  await dropBatch(campaign, batch, code, 'pending');
  if (code === 'VOICE_API_AUTH' || code === 'VOICE_API_NO_CREDITS') {
    await pauseAllVoice(code);
  } else {
    if (code === 'VOICE_API_REJECTED') await recordProviderError(code);
    await pauseFor(campaign, 'provider_error', code);
  }
  return 'paused';
};

/**
 * Superadmin decision on an uncertain batch: it reached Cell24x7 (with its request id —
 * results then follow) or it did not (money and numbers go back).
 */
export const resolveVoiceBatch = async (
  campaignId: string,
  batchNo: number,
  decision: { outcome: 'submitted'; requestId: string } | { outcome: 'not_submitted' },
): Promise<{ campaign: CampaignDoc; batch: VoiceBatch }> => {
  const _id = Types.ObjectId.isValid(campaignId) ? new Types.ObjectId(campaignId) : null;
  const campaign = _id
    ? await CampaignModel.findOne({ _id, line: 'voice_api' }).lean<CampaignDoc>()
    : null;
  const batch = campaign?.voiceApi?.batches.find((b) => b.no === batchNo);
  if (!campaign || !batch) throw new AppError('RESOURCE_NOT_FOUND', 'Batch not found');
  if (batch.state !== 'uncertain')
    throw new AppError('CONFLICT_INVALID_STATE', 'Only an uncertain batch can be resolved.');
  const result = await withLock(campaignId, async () => {
    if (decision.outcome === 'not_submitted') {
      await dropBatch(
        campaign,
        batch,
        'not_submitted',
        campaign.status === 'canceled' || campaign.status === 'completed' ? 'canceled' : 'pending',
      );
      return 'failed' as const;
    }
    const at = new Date();
    await setBatch(campaign._id, batch.no, {
      state: 'open',
      requestId: decision.requestId,
      submittedAt: at,
      error: null,
    });
    const moved = await CampaignContactModel.updateMany(
      { campaignId: campaign._id, status: 'queued', 'voiceApi.batchNo': batch.no },
      {
        $set: {
          status: 'calling',
          'voiceApi.requestId': decision.requestId,
          lastAttemptAt: at,
          claimedAt: null,
        },
        $inc: { attempts: 1, dials: 1 },
      },
    );
    if (batch.holdId) {
      await captureVoiceApi({
        accountId: campaign.accountId,
        holdId: batch.holdId,
        campaignId,
        batchNo: batch.no,
      });
    }
    await CampaignModel.updateOne(
      { _id: campaign._id },
      {
        $inc: {
          'stats.queued': -moved.modifiedCount,
          'stats.calling': moved.modifiedCount,
          'stats.attempts': moved.modifiedCount,
          'stats.spentMicros': batch.amountMicros,
        },
      },
    );
    await getVoiceJobs()?.poll(campaignId);
    return 'open' as const;
  });
  if (result === 'busy')
    throw new AppError('CONFLICT_INVALID_STATE', 'The campaign is busy — try again.');
  publishProgress(campaignId);
  return { campaign, batch: { ...batch, state: result } };
};
