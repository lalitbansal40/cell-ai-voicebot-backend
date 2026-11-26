import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { VOICE_API_CONFIG } from '../../config/voice-api';
import { getAppRedis } from '../../core/queues/redis';
import {
  VOICE_API_STATUSES,
  VoiceApiError,
  toReceiver10,
  type VoiceNetworkReason,
} from '../../core/voice-api/types';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { voiceAudioFor } from '../campaigns/voice-api/batch';
import { notifyPlatform } from '../notifications/notifications.service';

import { accountUsesOwnToken, voiceCallerIdFor, voiceClientFor } from './clients';
import { toAppError } from './status';
import { voicePlatformAudit } from './voice-api.service';

/**
 * IVR (Cell24x7) checks a superadmin runs from the panel — no server access needed:
 * **Test connection** (`GET /ivrs` with the account's login), **Send test call** (one number,
 * owner-approved, Cell24x7 credits used, our wallet not charged), its result from `/details`,
 * the **last provider answer** (field names / statuses seen, numbers masked), unknown statuses
 * and "no credits" (402) answers of the last 24 h.
 */

const redisOf = (): Redis => getAppRedis(getEnv().REDIS_URL, getLogger());

export type VoiceCheckReason =
  'ok' | 'timeout' | 'dns' | 'tls' | 'refused' | 'network' | 'auth' | 'no_credits' | 'error';

export interface VoiceLastCheck {
  ok: boolean;
  reason: VoiceCheckReason;
  httpStatus: number | null;
  ivrs: number | null;
  at: string;
}

const networkReason = (n: VoiceNetworkReason): VoiceCheckReason =>
  n === 'connect' ? 'refused' : n === 'network' ? 'network' : n;

const accountOf = async (id: string): Promise<AccountDoc> => {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError();
  const account = await AccountModel.findById(id).lean<AccountDoc>();
  if (!account || account.isPlatform) throw new NotFoundError();
  return account;
};

const scopeOf = async (accountId: Types.ObjectId) =>
  (await accountUsesOwnToken(accountId)) ? accountId.toString() : 'platform';

/** Digit runs that could be phone numbers → `…last4` (ids of a request stay readable). */
const mask = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replace(/\d{8,}/g, (d) => `…${d.slice(-4)}`);
  if (typeof value === 'number' && String(value).length >= 8) return `…${String(value).slice(-4)}`;
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !/token|secret|audio_url|file_url/i.test(k))
        .map(([k, v]) => [k, mask(v)]),
    );
  }
  return value;
};

const keysOf = (value: unknown, prefix = ''): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    `${prefix}${k}`,
    ...(v && typeof v === 'object' && !Array.isArray(v) ? keysOf(v, `${prefix}${k}.`) : []),
  ]);
};

const statusOf = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const s = (value as Record<string, unknown>).status;
  return typeof s === 'string' ? s.trim() : null;
};

/** IVR-T3: remembers the shape of a provider answer (7 days, numbers masked). */
export const recordVoiceShape = async (
  scope: string,
  source: 'details' | 'webhook',
  rows: unknown[],
): Promise<void> => {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap((r) => keysOf(r)))].sort();
  const statusValues = [...new Set(rows.map(statusOf).filter((s): s is string => Boolean(s)))];
  const shape = {
    source,
    keys,
    statusValues,
    sample: mask(rows[0]),
    at: new Date().toISOString(),
  };
  await redisOf()
    .set(`voiceapi:lastshape:${scope}:${source}`, JSON.stringify(shape), 'EX', 7 * 86_400)
    .catch(() => undefined);
};

const KNOWN = new Set(VOICE_API_STATUSES.map((s) => s.toUpperCase()));

/** IVR-T3: a status the status map doesn't know — logged, kept, superadmins rung once a day. */
export const noteUnknownVoiceStatus = async (status: string): Promise<void> => {
  const upper = status.trim().toUpperCase();
  if (!upper || KNOWN.has(upper)) return;
  const redis = redisOf();
  await redis.sadd('voiceapi:unknown-statuses', upper.slice(0, 40)).catch(() => undefined);
  getLogger().warn({ status: upper.slice(0, 40) }, 'voice_api_unknown_status');
  const first = await redis
    .set(`voiceapi:unknown-status:${upper.slice(0, 40)}`, '1', 'EX', 86_400, 'NX')
    .catch(() => null);
  if (first !== 'OK') return;
  await notifyPlatform({
    type: 'voice_api.provider_error',
    title: 'Recorded voice: unknown provider status',
    body: `Cell24x7 sent the status "${upper.slice(0, 40)}", which we don't map yet. Numbers with it stay "dialing" until a known status comes.`,
    link: '/admin/system',
  }).catch(() => 0);
};

/** IVR-T6: a 402 (no credits) answer, for the "last 24 h" count. */
export const noteVoiceNoCredits = async (scope: string): Promise<void> => {
  const key = `voiceapi:402:${scope}`;
  const redis = redisOf();
  await redis.lpush(key, String(Date.now())).catch(() => undefined);
  await redis.ltrim(key, 0, 99).catch(() => undefined);
  await redis.expire(key, 2 * 86_400).catch(() => undefined);
};

const noCredits24h = async (scope: string): Promise<number> => {
  const list = await redisOf()
    .lrange(`voiceapi:402:${scope}`, 0, 99)
    .catch(() => [] as string[]);
  const since = Date.now() - 86_400_000;
  return list.filter((t) => Number(t) >= since).length;
};

const lastCheckOf = (account: AccountDoc): VoiceLastCheck | null =>
  (account.voiceApi as { lastCheck?: VoiceLastCheck } | undefined)?.lastCheck ?? null;

/** IVR-T1: `GET /ivrs` with the account's login → reachable / key valid, or why not. */
export const testVoiceConnection = async (req: Request, id: string): Promise<VoiceLastCheck> => {
  const account = await accountOf(id);
  const client = await voiceClientFor(account._id);
  if (!client) throw new AppError('VOICE_API_NOT_ENABLED');
  let check: VoiceLastCheck;
  try {
    const ivrs = await client.ivrs();
    check = {
      ok: true,
      reason: 'ok',
      httpStatus: 200,
      ivrs: ivrs.length,
      at: new Date().toISOString(),
    };
  } catch (err) {
    const v = err instanceof VoiceApiError ? err : null;
    const reason: VoiceCheckReason = v?.network
      ? networkReason(v.network)
      : v?.code === 'VOICE_API_AUTH'
        ? 'auth'
        : v?.code === 'VOICE_API_NO_CREDITS'
          ? 'no_credits'
          : 'error';
    if (reason === 'no_credits') await noteVoiceNoCredits(await scopeOf(account._id));
    check = {
      ok: false,
      reason,
      httpStatus: v && v.status > 0 ? v.status : null,
      ivrs: null,
      at: new Date().toISOString(),
    };
  }
  await AccountModel.updateOne({ _id: account._id }, { $set: { 'voiceApi.lastCheck': check } });
  await voicePlatformAudit(
    req,
    'voice_api.connection_tested',
    { type: 'account', id: account._id.toString() },
    { ok: check.ok, reason: check.reason },
    account._id,
  );
  return check;
};

export interface VoiceTestCall {
  requestId: string;
  phoneLast4: string;
  content: 'audio' | 'ivr';
  at: string;
}

/** IVR-T2: one number, owner-approved (3 / hour / account); Cell24x7 credits, no wallet charge. */
export const sendVoiceTestCall = async (
  req: Request,
  id: string,
  input: {
    phone: string;
    content: { kind: 'audio'; flowAudioId: string } | { kind: 'ivr'; ivrId: number };
    ownerApproved: boolean;
  },
): Promise<VoiceTestCall> => {
  if (!input.ownerApproved) {
    throw new AppError('VALIDATION_FAILED', undefined, [
      { path: 'ownerApproved', message: "Tick it only with the account owner's OK" },
    ]);
  }
  const account = await accountOf(id);
  const receiver = toReceiver10(
    input.phone.startsWith('+') ? input.phone : `+91${input.phone.replace(/\D/g, '').slice(-10)}`,
  );
  if (!receiver) {
    throw new AppError('VALIDATION_FAILED', undefined, [
      { path: 'phone', message: 'A 10-digit Indian mobile number' },
    ]);
  }
  const client = await voiceClientFor(account._id);
  if (!client) throw new AppError('VOICE_API_NOT_ENABLED');
  const redis = redisOf();
  const limitKey = `voiceapi:testcall:${account._id.toString()}`;
  const used = await redis.incr(limitKey);
  if (used === 1) await redis.expire(limitKey, 3600);
  if (used > VOICE_API_CONFIG.testCallsPerHour) {
    throw new AppError('RATE_LIMITED', 'At most 3 test calls an hour for an account.');
  }
  const ownToken = await accountUsesOwnToken(account._id);
  const { audio } = await voiceAudioFor(
    account._id,
    input.content.kind === 'ivr'
      ? { kind: 'ivr', ivrId: input.content.ivrId }
      : { kind: 'audio', flowAudioId: input.content.flowAudioId },
    undefined,
    true,
    ownToken,
  );
  let requestId: string;
  try {
    const answer = await client.submit({
      broadcastName: `cav-test-${account._id.toString()}-${String(Date.now())}`,
      callerId: await voiceCallerIdFor(account._id),
      numbers: [receiver],
      audio,
      retries: 0,
      retryIntervalMin: 5,
    });
    requestId = answer.requestId;
  } catch (err) {
    if (err instanceof VoiceApiError && err.code === 'VOICE_API_NO_CREDITS')
      await noteVoiceNoCredits(await scopeOf(account._id));
    throw toAppError(err, 'VOICE_API_AUDIO_INVALID');
  }
  const test: VoiceTestCall = {
    requestId,
    phoneLast4: receiver.slice(-4),
    content: input.content.kind,
    at: new Date().toISOString(),
  };
  await AccountModel.updateOne({ _id: account._id }, { $set: { 'voiceApi.lastTestCall': test } });
  await voicePlatformAudit(
    req,
    'voice_api.test_call_sent',
    { type: 'account', id: account._id.toString() },
    { phoneLast4: test.phoneLast4, content: test.content },
    account._id,
  );
  return test;
};

/** IVR-T2: the last test call's result from `/details` (and its shape, IVR-T3). */
export const voiceTestCallResult = async (id: string) => {
  const account = await accountOf(id);
  const test = (account.voiceApi as { lastTestCall?: VoiceTestCall } | undefined)?.lastTestCall;
  if (!test) throw new ConflictError('CONFLICT_INVALID_STATE', 'No test call sent yet.');
  const client = await voiceClientFor(account._id);
  if (!client) throw new AppError('VOICE_API_NOT_ENABLED');
  let page;
  try {
    page = await client.details(test.requestId, 1);
  } catch (err) {
    throw toAppError(err);
  }
  await recordVoiceShape(await scopeOf(account._id), 'details', page.raw ?? []);
  const row = page.rows[0] ?? null;
  if (row) await noteUnknownVoiceStatus(row.status);
  return {
    test,
    result: row
      ? {
          status: row.status,
          durationSec: row.durationSec,
          retryCount: row.retryCount,
          keyPressed: row.dtmf,
          ivrDisposition: row.ivrDisposition,
        }
      : null,
  };
};

/** IVR-T1/T3/T6: what the Cell24x7 card shows (no secrets, numbers masked). */
export const voiceDiagnostics = async (id: string) => {
  const account = await accountOf(id);
  const scope = await scopeOf(account._id);
  const read = async (source: 'details' | 'webhook') => {
    const raw = await redisOf()
      .get(`voiceapi:lastshape:${scope}:${source}`)
      .catch(() => null);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  };
  const unknown = await redisOf()
    .smembers('voiceapi:unknown-statuses')
    .catch(() => [] as string[]);
  return {
    lastCheck: lastCheckOf(account),
    lastTestCall:
      (account.voiceApi as { lastTestCall?: VoiceTestCall } | undefined)?.lastTestCall ?? null,
    lastShape: { details: await read('details'), webhook: await read('webhook') },
    unknownStatuses: unknown.sort(),
    noCredits24h: await noCredits24h(scope),
    incoming: 'not_available' as const,
    // the account's newest audio files, for the test call picker (names only, no URLs)
    audio: (
      await FlowAudioModel.find({ accountId: account._id, deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(50)
        .select({ name: 1, durationMs: 1 })
        .lean()
    ).map((a) => ({ id: a._id.toString(), name: a.name, durationMs: a.durationMs })),
  };
};
