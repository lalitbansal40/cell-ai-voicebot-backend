import type { Request } from 'express';
import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { VOICE_API_CONFIG } from '../../config/voice-api';
import { getVoiceApiClient } from '../../core/voice-api';
import type { VoiceIvr } from '../../core/voice-api/types';
import {
  AccountModel,
  DEFAULT_ACCOUNT_VOICE_API,
  DEFAULT_VOICE_CREDENTIALS,
  type AccountDoc,
  type AccountVoiceApi,
  type AccountVoiceCredentials,
} from '../../db/models/account.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { toObjectId } from '../../shared/auth/tenant';
import { seal, secretBoxKey } from '../../shared/crypto/secret-box';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { recordAudit } from '../audit/audit.service';

import {
  accountUsesOwnToken,
  accountWebhookUrl,
  clientForToken,
  credentialsOf,
  forgetVoiceClient,
  newWebhookKey,
  usesOwnToken,
  voiceClientFor,
} from './clients';
import {
  notifyAccountProviderError,
  readProviderStatus,
  recordProviderError,
  toAppError,
  voiceWebhookUrl,
} from './status';

/** Provider support ships with the code; account credentials are configured in the dashboard. */
export const voiceProviderOn = (): boolean => VOICE_API_CONFIG.enabled;

/** The account's recorded-voice switches (never its credentials). */
export const voiceSettingsOf = (
  account: { voiceApi?: Partial<AccountVoiceApi> | null } | null,
) => ({
  enabled: account?.voiceApi?.enabled ?? DEFAULT_ACCOUNT_VOICE_API.enabled,
  ivrIds: [...(account?.voiceApi?.ivrIds ?? [])],
  ivrEstimateSec: account?.voiceApi?.ivrEstimateSec ?? DEFAULT_ACCOUNT_VOICE_API.ivrEstimateSec,
});

/** Which Cell24x7 login the account uses — safe to show (token: last 4 only). */
export const voiceCredentialsView = (
  account: { voiceApi?: Partial<AccountVoiceApi> | null } | null,
) => {
  const c = credentialsOf(account?.voiceApi);
  const own = usesOwnToken(c);
  return {
    mode: own ? ('own' as const) : ('platform' as const),
    tokenHint: own ? c.tokenHint : null,
    callerId: own ? c.callerId : null,
    verifiedAt: own ? (c.verifiedAt?.toISOString() ?? null) : null,
    webhookRegisteredAt: own ? (c.webhookRegisteredAt?.toISOString() ?? null) : null,
  };
};

/** Recorded voice needs an enabled account and either its own token or a shared platform login. */
export const accountVoiceApi = async (accountId: Types.ObjectId | string) => {
  const account = await AccountModel.findById(accountId)
    .select({ voiceApi: 1 })
    .lean<{ voiceApi?: AccountVoiceApi }>();
  const settings = voiceSettingsOf(account);
  const connected = usesOwnToken(credentialsOf(account?.voiceApi)) || getVoiceApiClient() !== null;
  return { ...settings, enabled: settings.enabled && voiceProviderOn() && connected };
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

const ownIvrCache = new Map<string, { at: number; list: VoiceIvr[] }>();

/**
 * IVRs this account may use: on its own Cell24x7 token every runnable IVR of that login;
 * on the platform token those a superadmin assigned (and runnable).
 */
export const accountIvrs = async (accountId: Types.ObjectId | string) => {
  const settings = await accountVoiceApi(accountId);
  if (!settings.enabled) return [];
  if (await accountUsesOwnToken(accountId)) {
    const key = accountId.toString();
    const hit = ownIvrCache.get(key);
    let list = hit && Date.now() - hit.at < IVR_CACHE_MS ? hit.list : null;
    if (!list) {
      const client = await voiceClientFor(accountId);
      if (!client) return [];
      try {
        list = await client.ivrs();
      } catch (err) {
        const app = toAppError(err);
        if (app.code === 'VOICE_API_AUTH' || app.code === 'VOICE_API_NO_CREDITS')
          await notifyAccountProviderError(accountId, app.code);
        throw app;
      }
      ownIvrCache.set(key, { at: Date.now(), list });
    }
    return list.filter((i) => i.runnable).map((i) => ({ id: i.id, name: i.name }));
  }
  if (settings.ivrIds.length === 0) return [];
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
  // only the switches: the account's own Cell24x7 credentials stay as they are
  await AccountModel.updateOne(
    { _id: account._id },
    {
      $set: {
        'voiceApi.enabled': next.enabled,
        'voiceApi.ivrIds': next.ivrIds,
        'voiceApi.ivrEstimateSec': next.ivrEstimateSec,
      },
    },
  );
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
    provider: voiceProviderOn() ? (client?.provider ?? VOICE_API_CONFIG.provider) : 'off',
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

/* ── per-account Cell24x7 login (own token, caller ID, webhook) ── */

type CredentialsAction = 'voice_api.credentials_changed' | 'voice_api.account_webhook_registered';

const credentialsAudit = async (
  req: Request,
  action: CredentialsAction,
  accountId: Types.ObjectId,
  meta: Record<string, unknown>,
) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
    action,
    target: { type: 'account', id: accountId.toString() },
    meta,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId });
  await recordAudit({ ...base, accountId: auth.accountId });
};

/**
 * Superadmin: the account's own Cell24x7 token + caller ID (checked against Cell24x7 before
 * it is saved, sealed at rest), or back to the platform token. A new token needs its
 * webhook registered again.
 */
export const setVoiceCredentials = async (
  req: Request,
  id: string,
  body:
    | { mode: 'platform' }
    | { mode: 'own'; token?: string | undefined; callerId?: string | null | undefined },
) => {
  const account = await customerAccount(id);
  if (!voiceProviderOn())
    throw new AppError('VOICE_API_NOT_ENABLED', 'No voice provider on this server.');
  const before = credentialsOf(account.voiceApi);
  if (body.mode === 'platform') {
    if (!getVoiceApiClient())
      throw new AppError(
        'VOICE_API_NOT_ENABLED',
        "No shared platform login is configured. Connect this account's own Cell24x7 API key.",
      );
    await AccountModel.updateOne(
      { _id: account._id },
      { $set: { 'voiceApi.credentials': { ...DEFAULT_VOICE_CREDENTIALS } } },
    );
    forgetVoiceClient(account._id);
    await credentialsAudit(req, 'voice_api.credentials_changed', account._id, { mode: 'platform' });
    return voiceCredentialsView(await AccountModel.findById(account._id).lean<AccountDoc>());
  }
  const token = body.token?.trim();
  if (!token && !before.tokenSealed)
    throw new ValidationError([{ path: 'token', message: 'Enter the Cell24x7 API token' }]);
  let next: AccountVoiceCredentials = {
    ...before,
    mode: 'own',
    ...(body.callerId !== undefined ? { callerId: body.callerId } : {}),
  };
  if (token) {
    // the token must work before it is saved (Cell24x7 lists the account's IVRs)
    const client = clientForToken(token);
    if (!client) throw new AppError('VOICE_API_NOT_ENABLED');
    try {
      await client.ivrs();
    } catch (err) {
      throw toAppError(err);
    }
    next = {
      ...next,
      tokenSealed: seal(secretBoxKey(getEnv()), token),
      tokenHint: token.slice(-4),
      verifiedAt: new Date(),
      // the old webhook belongs to the old token
      ...(before.tokenSealed ? { webhookKeyHash: null, webhookRegisteredAt: null } : {}),
    };
  }
  await AccountModel.updateOne({ _id: account._id }, { $set: { 'voiceApi.credentials': next } });
  forgetVoiceClient(account._id);
  ownIvrCache.delete(account._id.toString());
  await credentialsAudit(req, 'voice_api.credentials_changed', account._id, {
    mode: 'own',
    tokenChanged: Boolean(token),
    tokenHint: next.tokenHint,
    callerIdSet: Boolean(next.callerId),
  });
  return voiceCredentialsView(await AccountModel.findById(account._id).lean<AccountDoc>());
};

/** Superadmin: points the account's own Cell24x7 login at its own result URL. */
export const registerAccountVoiceWebhook = async (req: Request, id: string) => {
  const account = await customerAccount(id);
  if (!usesOwnToken(credentialsOf(account.voiceApi)))
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'This account uses the platform token; register the platform webhook in Admin → System.',
    );
  const client = await voiceClientFor(account._id);
  if (!client) throw new AppError('VOICE_API_NOT_ENABLED');
  const { key, hash } = newWebhookKey();
  try {
    await client.setWebhook(accountWebhookUrl(account._id.toString(), key));
  } catch (err) {
    throw toAppError(err);
  }
  await AccountModel.updateOne(
    { _id: account._id },
    {
      $set: {
        'voiceApi.credentials.webhookKeyHash': hash,
        'voiceApi.credentials.webhookRegisteredAt': new Date(),
      },
    },
  );
  await credentialsAudit(req, 'voice_api.account_webhook_registered', account._id, {});
  return voiceCredentialsView(await AccountModel.findById(account._id).lean<AccountDoc>());
};
