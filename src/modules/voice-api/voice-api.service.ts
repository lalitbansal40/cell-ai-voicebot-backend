import type { Request } from 'express';
import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { getVoiceApiClient } from '../../core/voice-api';
import type { VoiceIvr } from '../../core/voice-api/types';
import {
  AccountModel,
  DEFAULT_ACCOUNT_VOICE_API,
  type AccountDoc,
  type AccountVoiceApi,
} from '../../db/models/account.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { toObjectId } from '../../shared/auth/tenant';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { recordAudit } from '../audit/audit.service';

import { readProviderStatus, recordProviderError, toAppError, voiceWebhookUrl } from './status';

/** The install has a voice provider (`VOICE_API_PROVIDER` not `off`). */
export const voiceProviderOn = (): boolean => getVoiceApiClient() !== null;

export const voiceSettingsOf = (
  account: { voiceApi?: Partial<AccountVoiceApi> | null } | null,
) => ({
  ...DEFAULT_ACCOUNT_VOICE_API,
  ...account?.voiceApi,
  ivrIds: [...(account?.voiceApi?.ivrIds ?? [])],
});

/** The account's recorded-voice settings; `enabled` only when the install has a provider too. */
export const accountVoiceApi = async (accountId: Types.ObjectId | string) => {
  const account = await AccountModel.findById(accountId)
    .select({ voiceApi: 1 })
    .lean<{ voiceApi?: AccountVoiceApi }>();
  const settings = voiceSettingsOf(account);
  return { ...settings, enabled: settings.enabled && voiceProviderOn() };
};

/** Throws unless the account may run recorded-voice campaigns. */
export const requireVoiceApi = async (accountId: Types.ObjectId | string) => {
  const settings = await accountVoiceApi(accountId);
  if (!settings.enabled) throw new AppError('VOICE_API_NOT_ENABLED');
  return settings;
};

const IVR_CACHE_MS = 60_000;
let ivrCache: { at: number; list: VoiceIvr[] } | null = null;

/** Every IVR on the platform's Cell24x7 account (superadmin only; cached 60 s). */
export const providerIvrs = async (fresh = false): Promise<VoiceIvr[]> => {
  const client = getVoiceApiClient();
  if (!client) return [];
  if (!fresh && ivrCache && Date.now() - ivrCache.at < IVR_CACHE_MS) return ivrCache.list;
  try {
    const list = await client.ivrs();
    ivrCache = { at: Date.now(), list };
    return list;
  } catch (err) {
    const app = toAppError(err);
    if (app.code === 'VOICE_API_AUTH' || app.code === 'VOICE_API_NO_CREDITS')
      await recordProviderError(app.code);
    throw app;
  }
};

/** Tests: forget the cached IVR list. */
export const resetIvrCache = (): void => {
  ivrCache = null;
};

/** IVRs this account may use: assigned by a superadmin and runnable at Cell24x7. */
export const accountIvrs = async (accountId: Types.ObjectId | string) => {
  const settings = await accountVoiceApi(accountId);
  if (!settings.enabled || settings.ivrIds.length === 0) return [];
  const assigned = new Set(settings.ivrIds);
  return (await providerIvrs())
    .filter((i) => i.runnable && assigned.has(i.id))
    .map((i) => ({ id: i.id, name: i.name }));
};

const customerAccount = async (id: string): Promise<AccountDoc> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const account = await AccountModel.findById(_id).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  if (account.isPlatform)
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The platform account cannot be managed here.',
    );
  return account;
};

const platformAudit = async (
  req: Request,
  action: 'account.voice_api_changed' | 'voice_api.webhook_registered' | 'voice_api.batch_resolved',
  target: { type: string; id: string },
  meta: Record<string, unknown>,
  accountId?: Types.ObjectId,
) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
    action,
    target,
    meta,
    ip: req.ip ?? null,
  };
  if (accountId) await recordAudit({ ...base, accountId });
  await recordAudit({ ...base, accountId: auth.accountId });
};

export { platformAudit as voicePlatformAudit };

/** Superadmin: turn recorded voice on / off, assign IVRs and the IVR billing estimate. */
export const setAccountVoiceApi = async (
  req: Request,
  id: string,
  body: Partial<AccountVoiceApi>,
) => {
  const account = await customerAccount(id);
  const next = voiceSettingsOf({ voiceApi: { ...voiceSettingsOf(account), ...body } });
  next.ivrIds = [...new Set(next.ivrIds)].sort((a, b) => a - b);
  await AccountModel.updateOne({ _id: account._id }, { $set: { voiceApi: next } });
  await platformAudit(
    req,
    'account.voice_api_changed',
    { type: 'account', id: account._id.toString() },
    { enabled: next.enabled, ivrIds: next.ivrIds.length, ivrEstimateSec: next.ivrEstimateSec },
    account._id,
  );
  return next;
};

/** Admin → System: is Cell24x7 set up (never the token or the secret URL). */
export const adminVoiceStatus = async () => {
  const env = getEnv();
  const client = getVoiceApiClient();
  const expectedUrl = client ? voiceWebhookUrl() : null;
  let registered: string | null = null;
  let webhookError: string | null = null;
  if (client) {
    try {
      registered = await client.getWebhook();
    } catch (err) {
      webhookError = toAppError(err).code;
    }
  }
  const uncertain = await CampaignModel.find(
    { line: 'voice_api', 'voiceApi.batches.state': 'uncertain', deletedAt: null },
    { name: 1, accountId: 1, voiceApi: 1 },
  )
    .limit(100)
    .lean();
  return {
    provider: env.VOICE_API_PROVIDER,
    tokenConfigured:
      env.VOICE_API_PROVIDER === 'cell24x7' ? Boolean(env.CELL24X7_VOICE_API_TOKEN) : false,
    webhook: {
      registered: registered !== null,
      matches: expectedUrl !== null && registered === expectedUrl,
      error: webhookError,
    },
    ...(await readProviderStatus()),
    uncertainBatches: uncertain.flatMap((c) =>
      (c.voiceApi?.batches ?? [])
        .filter((b) => b.state === 'uncertain')
        .map((b) => ({
          campaignId: c._id.toString(),
          campaignName: c.name,
          accountId: c.accountId.toString(),
          batchNo: b.no,
          count: b.count,
          broadcastName: `cav-${c._id.toString()}-${String(b.no)}`,
          error: b.error,
          createdAt: b.createdAt.toISOString(),
        })),
    ),
  };
};

/** Admin → System → Register webhook: points Cell24x7 at our result route. */
export const registerVoiceWebhook = async (req: Request) => {
  const client = getVoiceApiClient();
  if (!client) throw new AppError('VOICE_API_NOT_ENABLED', 'No voice provider on this server.');
  const url = voiceWebhookUrl();
  try {
    await client.setWebhook(url);
  } catch (err) {
    throw toAppError(err);
  }
  await platformAudit(
    req,
    'voice_api.webhook_registered',
    { type: 'platform', id: 'voice_api' },
    { matches: true },
  );
  return { registered: true, matches: true };
};
