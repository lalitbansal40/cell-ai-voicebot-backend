import { createHash } from 'node:crypto';

import type { ZodType } from 'zod';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { getLogger, type Logger } from '../../shared/logger';

import { graphError, invalidResponse, metaErrorMeta, networkError, notConfigured } from './errors';
import {
  allocationSchema,
  businessesSchema,
  creditLineAttachSchema,
  debugTokenSchema,
  meSchema,
  oauthTokenSchema,
  ownedWabasSchema,
  phoneListSchema,
  phoneSchema,
  successSchema,
  syncRequestSchema,
  toAccessToken,
  toAllocation,
  toBusinesses,
  toCreditLineAttach,
  toDebugToken,
  toOwnedWabas,
  toPhone,
  toPhoneSummaries,
  toWaba,
  wabaSchema,
} from './schemas';
import type { MetaApiError, MetaClient } from './types';

export interface GraphMetaClientOptions {
  appId: string;
  appSecret: string;
  graphVersion: string;
  baseUrl: string;
  /** Our Solution Partner credit line (`META_CREDIT_LINE_ID`). */
  creditLineId?: string | undefined;
  /** System User token of our business (credit line calls). Never logged. */
  systemUserToken?: string | undefined;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Backoff wait (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
}

type Method = 'GET' | 'POST' | 'DELETE';

interface GraphRequest<T> {
  /** Name for logs — the URL is never logged (it may carry credentials). */
  op: string;
  method: Method;
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Bearer token; `null` for the two calls that take credentials in the query. */
  token: string | null;
  schema: ZodType<T>;
}

const PHONE_FIELDS = [
  'id',
  'display_phone_number',
  'verified_name',
  'name_status',
  'new_name_status',
  'quality_rating',
  'messaging_limit_tier',
  'code_verification_status',
  'platform_type',
  'throughput',
  'account_mode',
  'status',
  'is_official_business_account',
  'is_on_biz_app',
].join(',');

const WABA_FIELDS = [
  'id',
  'name',
  'currency',
  'timezone_id',
  'message_template_namespace',
  'account_review_status',
  'business_verification_status',
  'owner_business_info',
  'primary_funding_id',
].join(',');

const seg = (value: string) => encodeURIComponent(value);
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Real Meta Graph API client (plain `fetch`, no SDK). */
export const createGraphMetaClient = (options: GraphMetaClientOptions): MetaClient => {
  const {
    appId,
    appSecret,
    graphVersion,
    creditLineId,
    systemUserToken,
    fetch: fetchFn = fetch,
    sleep = defaultSleep,
    random = Math.random,
    timeoutMs = WHATSAPP_LIMITS.graphTimeoutMs,
    retries = WHATSAPP_LIMITS.graphRetries,
    retryBaseMs = WHATSAPP_LIMITS.graphRetryBaseMs,
  } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const log = () => options.logger ?? getLogger();
  const owners = new Map<string, string>();

  const once = async <T>(req: GraphRequest<T>): Promise<T> => {
    const url = new URL(`${baseUrl}/${graphVersion}/${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: req.method,
        headers: {
          accept: 'application/json',
          ...(req.token ? { authorization: `Bearer ${req.token}` } : {}),
          ...(req.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      throw networkError(name === 'TimeoutError' || name === 'AbortError');
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw res.ok ? invalidResponse(res.status, req.op) : graphError(res.status, null);
      }
    }
    if (!res.ok || (json && typeof json === 'object' && 'error' in json)) {
      throw graphError(res.status, json);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw invalidResponse(res.status, req.op);
    return parsed.data;
  };

  const call = async <T>(req: GraphRequest<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(req);
      } catch (err) {
        const metaErr = err as MetaApiError;
        const retry = metaErr.retryable && attempt < retries;
        log().warn(
          { op: req.op, attempt: attempt + 1, retry, ...metaErrorMeta(metaErr) },
          'meta: request failed',
        );
        if (!retry) throw metaErr;
        await sleep(retryBaseMs * 2 ** attempt + Math.floor(random() * retryBaseMs));
      }
    }
  };

  const bearer = <T>(
    op: string,
    method: Method,
    path: string,
    token: string,
    schema: ZodType<T>,
    extra: Pick<GraphRequest<T>, 'query' | 'body'> = {},
  ) => call({ op, method, path, token, schema, ...extra });

  return {
    provider: 'meta',

    async exchangeCode(code) {
      const raw = await call({
        op: 'oauth.access_token',
        method: 'GET',
        path: 'oauth/access_token',
        query: { client_id: appId, client_secret: appSecret, code },
        token: null,
        schema: oauthTokenSchema,
      });
      return toAccessToken(raw);
    },

    async debugToken(token) {
      const raw = await call({
        op: 'debug_token',
        method: 'GET',
        path: 'debug_token',
        query: { input_token: token, access_token: `${appId}|${appSecret}` },
        token: null,
        schema: debugTokenSchema,
      });
      return toDebugToken(raw);
    },

    async listOwnedWabas(token) {
      const raw = await bearer(
        'me.wabas',
        'GET',
        'me/whatsapp_business_accounts',
        token,
        ownedWabasSchema,
        {
          query: { fields: 'id,name' },
        },
      );
      return toOwnedWabas(raw);
    },

    async listBusinessesWithWabas(token) {
      const raw = await bearer('me.businesses', 'GET', 'me/businesses', token, businessesSchema, {
        query: { fields: 'id,name,owned_whatsapp_business_accounts{id,name}' },
      });
      return toBusinesses(raw);
    },

    async getWaba(token, wabaId) {
      const raw = await bearer('waba.get', 'GET', seg(wabaId), token, wabaSchema, {
        query: { fields: WABA_FIELDS },
      });
      return toWaba(raw);
    },

    async listPhoneNumbers(token, wabaId) {
      const raw = await bearer(
        'waba.phone_numbers',
        'GET',
        `${seg(wabaId)}/phone_numbers`,
        token,
        phoneListSchema,
        {
          query: { fields: 'id,display_phone_number,verified_name,status' },
        },
      );
      return toPhoneSummaries(raw);
    },

    async getPhoneNumber(token, phoneNumberId) {
      const raw = await bearer('phone.get', 'GET', seg(phoneNumberId), token, phoneSchema, {
        query: { fields: PHONE_FIELDS },
      });
      return toPhone(raw);
    },

    async subscribeApp(token, wabaId) {
      await bearer(
        'waba.subscribe',
        'POST',
        `${seg(wabaId)}/subscribed_apps`,
        token,
        successSchema,
      );
    },

    async unsubscribeApp(token, wabaId) {
      await bearer(
        'waba.unsubscribe',
        'DELETE',
        `${seg(wabaId)}/subscribed_apps`,
        token,
        successSchema,
      );
    },

    async getTokenOwner(token) {
      const key = tokenKey(token);
      const cached = owners.get(key);
      if (cached) return cached;
      const raw = await bearer('me', 'GET', 'me', token, meSchema, { query: { fields: 'id' } });
      if (owners.size >= 100) owners.clear();
      owners.set(key, raw.id);
      return raw.id;
    },

    async assignSystemUser(token, wabaId, userId) {
      await bearer(
        'waba.assigned_users',
        'POST',
        `${seg(wabaId)}/assigned_users`,
        token,
        successSchema,
        {
          query: { user: userId, tasks: "['MANAGE']" },
        },
      );
    },

    async attachCreditLine(wabaId, currency) {
      if (!creditLineId) throw notConfigured('The platform credit line (META_CREDIT_LINE_ID)');
      if (!systemUserToken) throw notConfigured('The System User token (META_SYSTEM_USER_TOKEN)');
      const raw = await bearer(
        'credit_line.attach',
        'POST',
        `${seg(creditLineId)}/whatsapp_credit_sharing_and_attach`,
        systemUserToken,
        creditLineAttachSchema,
        { query: { waba_id: wabaId, waba_currency: currency } },
      );
      return toCreditLineAttach(raw);
    },

    async getAllocation(allocationConfigId) {
      if (!systemUserToken) throw notConfigured('The System User token (META_SYSTEM_USER_TOKEN)');
      const raw = await bearer(
        'allocation.get',
        'GET',
        seg(allocationConfigId),
        systemUserToken,
        allocationSchema,
        {
          query: { fields: 'receiving_credential' },
        },
      );
      return toAllocation(raw);
    },

    async registerPhone(token, phoneNumberId, pin) {
      await bearer(
        'phone.register',
        'POST',
        `${seg(phoneNumberId)}/register`,
        token,
        successSchema,
        {
          body: { messaging_product: 'whatsapp', pin },
        },
      );
    },

    async requestCoexistenceSync(token, phoneNumberId, kind) {
      const raw = await bearer(
        'phone.smb_app_data',
        'POST',
        `${seg(phoneNumberId)}/smb_app_data`,
        token,
        syncRequestSchema,
        {
          body: { messaging_product: 'whatsapp', sync_type: kind },
        },
      );
      return { requestId: raw.request_id ?? null };
    },
  };
};
