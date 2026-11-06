import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import {
  Cell24x7VoiceClient,
  FakeVoiceClient,
  getVoiceApiClient,
  type VoiceApiClient,
} from '../../core/voice-api';
import {
  AccountModel,
  DEFAULT_VOICE_CREDENTIALS,
  type AccountVoiceApi,
  type AccountVoiceCredentials,
} from '../../db/models/account.model';
import { open, secretBoxKey } from '../../shared/crypto/secret-box';

/**
 * Which Cell24x7 login an account uses (per-account tokens): the platform client from env,
 * or a client with the account's own sealed token. Clients are cached for a minute and
 * dropped when the token changes. With the fake provider every account shares the fake.
 */

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; tokenSealed: string; client: VoiceApiClient }>();

export const credentialsOf = (
  voiceApi: Partial<AccountVoiceApi> | null | undefined,
): AccountVoiceCredentials => ({ ...DEFAULT_VOICE_CREDENTIALS, ...voiceApi?.credentials });

/** The account uses its own Cell24x7 token (and it is saved). */
export const usesOwnToken = (c: AccountVoiceCredentials): boolean =>
  c.mode === 'own' && Boolean(c.tokenSealed);

/** A client for a token (fake provider: the shared fake; never logs the token). */
export const clientForToken = (token: string): VoiceApiClient | null => {
  const platform = getVoiceApiClient();
  if (!platform) return null;
  if (platform instanceof FakeVoiceClient) return platform;
  return new Cell24x7VoiceClient({ baseUrl: getEnv().CELL24X7_VOICE_BASE_URL, token });
};

/** The account's campaigns run on its own Cell24x7 token. */
export const accountUsesOwnToken = async (accountId: Types.ObjectId | string): Promise<boolean> => {
  const account = await AccountModel.findById(accountId)
    .select({ voiceApi: 1 })
    .lean<{ voiceApi?: AccountVoiceApi }>();
  return usesOwnToken(credentialsOf(account?.voiceApi));
};

/** The client for an account's campaigns, IVRs and webhook; `null` = no provider on this server. */
export const voiceClientFor = async (
  accountId: Types.ObjectId | string,
): Promise<VoiceApiClient | null> => {
  const platform = getVoiceApiClient();
  if (!platform) return null;
  const account = await AccountModel.findById(accountId)
    .select({ voiceApi: 1 })
    .lean<{ voiceApi?: AccountVoiceApi }>();
  const c = credentialsOf(account?.voiceApi);
  if (!usesOwnToken(c)) return platform;
  const key = accountId.toString();
  const hit = cache.get(key);
  if (hit && hit.tokenSealed === c.tokenSealed && Date.now() - hit.at < CACHE_MS) return hit.client;
  const token = open(secretBoxKey(getEnv()), c.tokenSealed as string);
  const client = clientForToken(token) ?? platform;
  cache.set(key, { at: Date.now(), tokenSealed: c.tokenSealed as string, client });
  return client;
};

/** The caller ID of an account's broadcasts. */
export const voiceCallerIdFor = async (accountId: Types.ObjectId | string): Promise<string> => {
  const account = await AccountModel.findById(accountId)
    .select({ voiceApi: 1 })
    .lean<{ voiceApi?: AccountVoiceApi }>();
  const c = credentialsOf(account?.voiceApi);
  return (usesOwnToken(c) ? c.callerId : null) ?? getEnv().CELL24X7_VOICE_CALLER_ID;
};

/** Forget cached clients (token changed, tests). */
export const forgetVoiceClient = (accountId?: Types.ObjectId | string): void => {
  if (accountId === undefined) cache.clear();
  else cache.delete(accountId.toString());
};

/* ── the account's own webhook URL ── */

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** A new secret for an account's webhook URL (only its hash is stored). */
export const newWebhookKey = (): { key: string; hash: string } => {
  const key = randomBytes(24).toString('base64url');
  return { key, hash: hashKey(key) };
};

/** `…/webhooks/voice-api/a/<accountId>/<key>` — Cell24x7 allows one URL per token. */
export const accountWebhookUrl = (accountId: string, key: string): string =>
  `${getEnv().APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/voice-api/a/${accountId}/${key}`;

/** The secret in a webhook URL belongs to the account (constant-time). */
export const accountWebhookMatches = async (accountId: string, key: string): Promise<boolean> => {
  if (!/^[a-f0-9]{24}$/.test(accountId) || !key) return false;
  const account = await AccountModel.findById(accountId)
    .select({ voiceApi: 1 })
    .lean<{ voiceApi?: AccountVoiceApi }>();
  const c = credentialsOf(account?.voiceApi);
  if (!usesOwnToken(c) || !c.webhookKeyHash) return false;
  const a = Buffer.from(hashKey(key));
  const b = Buffer.from(c.webhookKeyHash);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Ids of accounts on their own token (platform webhook rows never match their batches). */
export const ownTokenAccountIds = async (ids: Types.ObjectId[]): Promise<Set<string>> => {
  if (!ids.length) return new Set();
  const rows = await AccountModel.find({
    _id: { $in: ids },
    'voiceApi.credentials.mode': 'own',
    'voiceApi.credentials.tokenSealed': { $type: 'string' },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  return new Set(rows.map((r) => r._id.toString()));
};
