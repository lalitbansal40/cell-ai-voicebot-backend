import { timingSafeEqual } from 'node:crypto';

import { Types } from 'mongoose';

import { getEnv } from '../../../config/env';
import {
  VOICE_API_FINAL_STATUSES,
  VoiceApiError,
  type VoiceApiClient,
  type VoiceResultEvent,
} from '../../../core/voice-api/types';
import { isDuplicateKeyError } from '../../../db/errors';
import { CallModel, type CallEndReason, type CallStatus } from '../../../db/models/call.model';
import {
  CampaignContactModel,
  type CallResult,
  type CampaignContactDoc,
  type CampaignContactStatus,
} from '../../../db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../../db/models/campaign.model';
import { ContactModel } from '../../../db/models/contact.model';
import { getLogger } from '../../../shared/logger';
import {
  accountUsesOwnToken,
  accountWebhookMatches,
  ownTokenAccountIds,
  voiceClientFor,
} from '../../voice-api/clients';
import {
  notifyAccountProviderError,
  recordProviderError,
  recordWebhookSeen,
} from '../../voice-api/status';
import { VoiceWebhookBody } from '../../voice-api/voice-api.schema';
import { completeIfDone, moveStats } from '../dispatcher';
import { publishProgress } from '../progress';

import { getVoiceJobs } from './jobs';

/**
 * VAPI results: the webhook (fast path) and `/details` polling (truth) feed the same
 * idempotent handler. The first final status counts once; a later ANSWERED (a provider
 * redial) upgrades a not-reached number. Unknown requests / numbers are ignored.
 */

interface Mapped {
  status: CampaignContactStatus;
  result: CallResult | null;
  call: CallStatus;
  endReason: CallEndReason;
}

const MAP: Record<string, Mapped> = {
  ANSWERED: {
    status: 'completed',
    result: 'answered',
    call: 'completed',
    endReason: 'customer_hangup',
  },
  'NO ANSWER': { status: 'failed', result: 'no_answer', call: 'no_answer', endReason: 'no_answer' },
  BUSY: { status: 'failed', result: 'busy', call: 'busy', endReason: 'busy' },
  FAILED: { status: 'failed', result: 'failed', call: 'failed', endReason: 'media_error' },
  STOP: { status: 'canceled', result: null, call: 'canceled', endReason: 'campaign_canceled' },
};

export type ApplyOutcome = 'ignored' | 'progress' | 'final' | 'upgraded' | 'repeat';

const perNumberMicros = (campaign: CampaignDoc | null, batchNo: number): number => {
  const batch = campaign?.voiceApi?.batches.find((b) => b.no === batchNo);
  return batch && batch.count > 0 ? Math.floor(batch.amountMicros / batch.count) : 0;
};

/** The minimal call row of a final result (contact history, reports); idempotent. */
const recordCall = async (
  cc: CampaignContactDoc,
  campaign: CampaignDoc | null,
  mapped: Mapped,
  event: VoiceResultEvent,
  costMicros: number,
): Promise<Types.ObjectId | null> => {
  const now = new Date();
  const answered = mapped.result === 'answered';
  const submittedAt = cc.lastAttemptAt ?? now;
  const answeredAt = answered
    ? new Date(Math.max(submittedAt.getTime(), now.getTime() - event.durationSec * 1000))
    : null;
  const outcome = {
    voiceApi: {
      status: event.status,
      ...(event.dtmf ? { dtmf: event.dtmf } : {}),
      ...(event.ivrDisposition ? { ivrDisposition: event.ivrDisposition } : {}),
      retries: event.retryCount,
    },
  };
  const fields = {
    status: mapped.call,
    endReason: mapped.endReason,
    durationSec: event.durationSec,
    outcome,
    'timestamps.answeredAt': answeredAt,
    'timestamps.endedAt': now,
  };
  try {
    const created = await CallModel.create({
      accountId: cc.accountId,
      direction: 'outbound',
      provider: 'voice_api',
      // unique per provider: one row per number of a Cell24x7 request
      providerCallId: `${event.requestId}:${event.receiver}`,
      from: getEnv().CELL24X7_VOICE_CALLER_ID,
      to: cc.phoneE164,
      isTest: false,
      mode: 'ai',
      source: { kind: null },
      contactId: cc.contactId,
      campaignId: cc.campaignId,
      campaignContactId: cc._id,
      attempt: 1,
      startedBy: campaign?.startedBy ?? null,
      status: mapped.call,
      endReason: mapped.endReason,
      durationSec: event.durationSec,
      outcome,
      timestamps: { queuedAt: submittedAt, ringingAt: submittedAt, answeredAt, endedAt: now },
      cost: {
        telephonyMicros: costMicros,
        aiMicros: 0,
        ttsMicros: 0,
        commissionMicros: 0,
        totalMicros: costMicros,
      },
      charged: true,
      // no transcript: nothing for the post-call AI
      insights: {
        status: 'skipped',
        reason: 'voice_api',
        version: 0,
        sentiment: null,
        hasPromise: false,
        promiseAmountMicros: null,
        hasSummary: false,
        at: now,
      },
    });
    return created._id;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await CallModel.findOneAndUpdate(
      { campaignContactId: cc._id, attempt: 1 },
      { $set: fields },
      { returnDocument: 'after' },
    ).lean<{ _id: Types.ObjectId }>();
    return existing?._id ?? null;
  }
};

/** Applies one number's result (webhook or poll). Never throws for unknown data. */
export const applyVoiceResult = async (event: VoiceResultEvent): Promise<ApplyOutcome> => {
  const receiver = event.receiver.replace(/\D/g, '').slice(-10);
  const matches = await CampaignContactModel.find({
    'voiceApi.requestId': event.requestId,
    'voiceApi.receiver10': receiver,
    ...(event.accountId ? { accountId: new Types.ObjectId(event.accountId) } : {}),
  })
    .limit(5)
    .lean<CampaignContactDoc[]>();
  // the platform login's rows: never a batch of an account on its own token
  const own = event.accountId
    ? new Set<string>()
    : await ownTokenAccountIds(matches.map((m) => m.accountId));
  const cc = matches.find((m) => !own.has(m.accountId.toString()));
  if (!cc?.voiceApi) return 'ignored';
  const status = event.status.trim().toUpperCase();
  const campaignId = cc.campaignId.toString();
  if (!VOICE_API_FINAL_STATUSES.has(status)) {
    await CampaignContactModel.updateOne(
      { _id: cc._id, status: 'calling', 'voiceApi.finalAt': null },
      { $set: { 'voiceApi.providerStatus': status } },
    );
    return 'progress';
  }
  const mapped = MAP[status] as Mapped;
  const details = {
    'voiceApi.providerStatus': status,
    'voiceApi.durationSec': Math.max(cc.voiceApi.durationSec, Math.round(event.durationSec)),
    'voiceApi.retryCount': Math.max(cc.voiceApi.retryCount, event.retryCount),
    ...(event.dtmf ? { 'voiceApi.dtmf': event.dtmf } : {}),
    ...(event.ivrDisposition ? { 'voiceApi.ivrDisposition': event.ivrDisposition } : {}),
  };
  const campaign = await CampaignModel.findById(cc.campaignId).lean<CampaignDoc>();
  const cost = perNumberMicros(campaign, cc.voiceApi.batchNo);
  let outcome: ApplyOutcome;
  let from: CampaignContactStatus = 'calling';
  // first final: only from `calling` (compare and set, so a duplicate counts once)
  const first = await CampaignContactModel.updateOne(
    { _id: cc._id, status: 'calling', 'voiceApi.finalAt': null },
    {
      $set: {
        ...details,
        status: mapped.status,
        lastResult: mapped.result,
        'voiceApi.finalAt': new Date(),
        costMicros: cost,
        claimToken: null,
        claimedAt: null,
      },
    },
  );
  if (first.modifiedCount) outcome = 'final';
  else if (
    status === 'ANSWERED' &&
    cc.status === 'failed' &&
    cc.voiceApi.providerStatus !== 'ANSWERED'
  ) {
    // a redial reached them after an earlier "not answered" result
    const up = await CampaignContactModel.updateOne(
      { _id: cc._id, status: 'failed', 'voiceApi.providerStatus': { $ne: 'ANSWERED' } },
      { $set: { ...details, status: 'completed', lastResult: 'answered' } },
    );
    if (!up.modifiedCount) return 'repeat';
    outcome = 'upgraded';
    from = 'failed';
  } else {
    // a repeat of a final status: details only (never the counters)
    await CampaignContactModel.updateOne(
      { _id: cc._id, 'voiceApi.providerStatus': status },
      { $set: details },
    );
    return 'repeat';
  }
  const inc: Record<string, number> = {
    ...moveStats(from, mapped.status),
    ...(mapped.result === 'answered' ? { 'stats.answered': 1 } : {}),
  };
  if (Object.keys(inc).length) {
    await CampaignModel.updateOne({ _id: cc.campaignId }, { $inc: inc });
  }
  const callId = await recordCall(cc, campaign, mapped, { ...event, receiver }, cost);
  if (callId) {
    await CampaignContactModel.updateOne({ _id: cc._id }, { $set: { lastCallId: callId } });
  }
  if (outcome === 'final') {
    await ContactModel.updateOne(
      { _id: cc.contactId, accountId: cc.accountId },
      { $set: { lastCalledAt: new Date() }, $inc: { callCount: 1 } },
    );
  }
  publishProgress(campaignId);
  await afterBatchChange(campaignId, cc.voiceApi.batchNo);
  return outcome;
};

/** A batch with no number dialing is done; the campaign may complete or send its next batch. */
const afterBatchChange = async (campaignId: string, batchNo: number): Promise<void> => {
  const id = new Types.ObjectId(campaignId);
  const dialing = await CampaignContactModel.exists({
    campaignId: id,
    status: 'calling',
    'voiceApi.batchNo': batchNo,
  });
  if (!dialing) {
    await CampaignModel.updateOne(
      {
        _id: id,
        voiceApi: { $ne: null },
        'voiceApi.batches': { $elemMatch: { no: batchNo, state: 'open' } },
      },
      { $set: { 'voiceApi.batches.$.state': 'done', 'voiceApi.batches.$.doneAt': new Date() } },
    );
  }
  const campaign = await CampaignModel.findById(id).lean<CampaignDoc>();
  if (!campaign) return;
  const waiting = campaign.voiceApi?.batches.some((b) =>
    ['holding', 'submitting', 'uncertain'].includes(b.state),
  );
  if (!waiting) await completeIfDone(campaign);
  if (campaign.status === 'running') await getVoiceJobs()?.batch(campaignId);
};

/**
 * Reads every open batch of a campaign from `/details` (the truth when webhooks were
 * lost) and applies the rows. Schedules itself again while batches stay open.
 */
export const pollVoiceCampaign = async (
  campaignId: string,
  deps: { client?: VoiceApiClient | null } = {},
): Promise<{ batches: number; rows: number }> => {
  const campaign = Types.ObjectId.isValid(campaignId)
    ? await CampaignModel.findById(campaignId).lean<CampaignDoc>()
    : null;
  if (!campaign?.voiceApi) return { batches: 0, rows: 0 };
  const client = deps.client === undefined ? await voiceClientFor(campaign.accountId) : deps.client;
  if (!client) return { batches: 0, rows: 0 };
  const own = await accountUsesOwnToken(campaign.accountId);
  const accountId = own ? { accountId: campaign.accountId.toString() } : {};
  let rows = 0;
  const open = campaign.voiceApi.batches.filter((b) => b.state === 'open' && b.requestId);
  for (const batch of open) {
    const pages = Math.ceil(batch.count / 100) + 1;
    try {
      for (let page = 1; page <= pages; page += 1) {
        const result = await client.details(batch.requestId as string, page);
        for (const row of result.rows) {
          rows += 1;
          // one bad row must not hold back the others
          await applyVoiceResult({
            ...row,
            requestId: batch.requestId as string,
            ...accountId,
          }).catch((err: unknown) =>
            getLogger().error({ err, campaignId, batchNo: batch.no }, 'voice api: result failed'),
          );
        }
        if (!result.hasMore) break;
      }
    } catch (err) {
      const code = err instanceof VoiceApiError ? err.code : 'unknown';
      if (code === 'VOICE_API_AUTH' || code === 'VOICE_API_NO_CREDITS') {
        if (own) await notifyAccountProviderError(campaign.accountId, code);
        else await recordProviderError(code);
      }
      getLogger().warn({ campaignId, batchNo: batch.no, code }, 'voice api: poll failed');
    }
    await CampaignModel.updateOne(
      { _id: campaign._id, 'voiceApi.batches.no': batch.no },
      { $set: { 'voiceApi.batches.$.lastPolledAt': new Date() } },
    );
    await afterBatchChange(campaignId, batch.no);
  }
  const fresh = await CampaignModel.findById(campaign._id).lean<CampaignDoc>();
  if (fresh?.voiceApi?.batches.some((b) => b.state === 'open')) {
    await getVoiceJobs()?.poll(campaignId, getEnv().VOICE_API_POLL_SEC * 1000);
  }
  return { batches: open.length, rows };
};

const secretMatches = (given: string): boolean => {
  const expected = getEnv().CELL24X7_WEBHOOK_SECRET;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Webhook body → event (`null` = not a result we understand). */
export const toVoiceEvent = (body: unknown): VoiceResultEvent | null => {
  const parsed = VoiceWebhookBody.safeParse(body);
  if (!parsed.success) return null;
  const b = parsed.data;
  const receiver = String(b.receiver).replace(/\D/g, '').slice(-10);
  if (receiver.length !== 10) return null;
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.round(x) : 0;
  };
  return {
    requestId: b.request_id,
    receiver,
    status:
      b.status.trim().toUpperCase() === 'SUBMITTED' ? 'Submitted' : b.status.trim().toUpperCase(),
    durationSec: n(b.duration),
    retryCount: n(b.retry_count),
    dtmf: b.ivr?.digits_pressed ? b.ivr.digits_pressed.slice(0, 32) : null,
    ivrDisposition: b.ivr?.disposition ? b.ivr.disposition.slice(0, 60) : null,
  };
};

/** Queues a result (or applies it now when this process has no queue). */
export const acceptVoiceResult = async (event: VoiceResultEvent): Promise<void> => {
  const jobs = getVoiceJobs();
  if (jobs) await jobs.result(event);
  else await applyVoiceResult(event);
};

/**
 * `POST /webhooks/voice-api/:secret`: wrong secret → `false` (404); a valid body is queued.
 * Malformed bodies are acknowledged and dropped (Cell24x7 must not retry them forever).
 */
export const handleVoiceWebhook = async (secret: string, body: unknown): Promise<boolean> => {
  if (!secretMatches(secret)) return false;
  await recordWebhookSeen();
  const event = toVoiceEvent(body);
  if (event) await acceptVoiceResult(event);
  return true;
};

/**
 * `POST /webhooks/voice-api/a/:accountId/:key`: results from an account's own Cell24x7
 * login (one webhook URL per token). Wrong account / key → `false` (404).
 */
export const handleAccountVoiceWebhook = async (
  accountId: string,
  key: string,
  body: unknown,
): Promise<boolean> => {
  if (!(await accountWebhookMatches(accountId, key))) return false;
  const event = toVoiceEvent(body);
  if (event) await acceptVoiceResult({ ...event, accountId });
  return true;
};
