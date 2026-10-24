import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

import type { ZodType } from 'zod';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { getLogger, type Logger } from '../../shared/logger';

import {
  callActionSchema,
  callAnalyticsSchema,
  toCallAnalyticsPoints,
  callingSettingsBody,
  callPermissionsSchema,
  phoneSettingsSchema,
  startCallSchema,
  toCallingSettings,
  toCallPermission,
} from './call-schemas';
import {
  graphError,
  invalidResponse,
  mediaRefused,
  metaErrorMeta,
  networkError,
  notConfigured,
} from './errors';
import {
  blockUsersSchema,
  businessProfileSchema,
  mediaUploadSchema,
  mediaUrlSchema,
  sendMessageSchema,
  toBlockResult,
  toBusinessProfile,
  toMediaUrl,
  uploadHandleSchema,
  uploadSessionSchema,
} from './message-schemas';
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
import {
  pricingAnalyticsSchema,
  templateCreatedSchema,
  templateListSchema,
  toPricingPoints,
  toTemplateCreated,
  toTemplatePage,
} from './template-schemas';
import {
  isAllowedMediaUrl,
  type MetaApiError,
  type MetaClient,
  type MetaUploadFile,
} from './types';

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
  /** Extra media hosts allowed for downloads (exact host — tests' local stub only). */
  mediaHosts?: readonly string[];
}

type Method = 'GET' | 'POST' | 'DELETE';

interface GraphRequest<T> {
  /** Name for logs — the URL is never logged (it may carry credentials). */
  op: string;
  method: Method;
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Multipart body (media upload). */
  form?: FormData;
  /** Raw bytes (resumable upload). */
  bytes?: Buffer;
  headers?: Record<string, string>;
  /** Bearer token; `null` for the two calls that take credentials in the query. */
  token: string | null;
  /** `OAuth` for the resumable upload API; Bearer otherwise. */
  authScheme?: 'Bearer' | 'OAuth';
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

const PROFILE_FIELDS = [
  'about',
  'address',
  'description',
  'email',
  'profile_picture_url',
  'websites',
  'vertical',
].join(',');

const TEMPLATE_FIELDS = [
  'id',
  'name',
  'language',
  'status',
  'category',
  'sub_category',
  'parameter_format',
  'components',
  'quality_score',
  'rejected_reason',
  'message_send_ttl_seconds',
].join(',');

/** `pricing_analytics` dimensions (Meta: comma list, no brackets). */
const PRICING_DIMENSIONS = 'PRICING_CATEGORY,PRICING_TYPE,COUNTRY';

const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

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
      const payload = req.form ?? (req.bytes ? new Uint8Array(req.bytes) : undefined);
      res = await fetchFn(url, {
        method: req.method,
        headers: {
          accept: 'application/json',
          ...(req.token ? { authorization: `${req.authScheme ?? 'Bearer'} ${req.token}` } : {}),
          ...(req.body ? { 'content-type': 'application/json' } : {}),
          ...req.headers,
        },
        ...(req.body ? { body: JSON.stringify(req.body) } : payload ? { body: payload } : {}),
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
    extra: Pick<
      GraphRequest<T>,
      'query' | 'body' | 'form' | 'bytes' | 'headers' | 'authScheme'
    > = {},
  ) => call({ op, method, path, token, schema, ...extra });

  /** Meta's resumable upload: session on the app, then the bytes (`OAuth` header) → handle. */
  const resumableUpload = async (op: string, token: string, file: MetaUploadFile) => {
    const session = await bearer(
      `${op}_session`,
      'POST',
      `${seg(appId)}/uploads`,
      token,
      uploadSessionSchema,
      {
        query: {
          ...(file.fileName ? { file_name: file.fileName } : {}),
          file_length: String(file.bytes.length),
          file_type: file.mimeType,
        },
      },
    );
    const raw = await bearer(op, 'POST', session.id, token, uploadHandleSchema, {
      bytes: file.bytes,
      authScheme: 'OAuth',
      headers: { file_offset: '0', 'content-type': file.mimeType },
    });
    return raw.h;
  };

  /** `pre_accept` / `accept` / `reject` / `terminate` on a call (same body shape, `success` answer). */
  const callAction = (
    token: string,
    phoneNumberId: string,
    action: 'pre_accept' | 'accept' | 'reject' | 'terminate',
    waCallId: string,
    extra: Record<string, unknown> = {},
  ) =>
    bearer(`calls.${action}`, 'POST', `${seg(phoneNumberId)}/calls`, token, callActionSchema, {
      body: { messaging_product: 'whatsapp', call_id: waCallId, action, ...extra },
    });

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

    async sendMessage(token, phoneNumberId, payload) {
      const raw = await bearer(
        'phone.messages',
        'POST',
        `${seg(phoneNumberId)}/messages`,
        token,
        sendMessageSchema,
        { body: payload },
      );
      return { waMessageId: raw.messages[0]?.id ?? '' };
    },

    async markRead(token, phoneNumberId, waMessageId, opts = {}) {
      await bearer(
        'phone.mark_read',
        'POST',
        `${seg(phoneNumberId)}/messages`,
        token,
        successSchema,
        {
          body: {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: waMessageId,
            ...(opts.typing ? { typing_indicator: { type: 'text' } } : {}),
          },
        },
      );
    },

    async uploadMedia(token, phoneNumberId, media) {
      // a fresh FormData per attempt (a body stream can be read once)
      const form = () => {
        const f = new FormData();
        f.set('messaging_product', 'whatsapp');
        f.set('type', media.mimeType);
        f.set(
          'file',
          new Blob([new Uint8Array(media.bytes)], { type: media.mimeType }),
          media.fileName,
        );
        return f;
      };
      for (let attempt = 0; ; attempt += 1) {
        try {
          const raw = await once({
            op: 'phone.media_upload',
            method: 'POST',
            path: `${seg(phoneNumberId)}/media`,
            token,
            form: form(),
            schema: mediaUploadSchema,
          });
          return raw.id;
        } catch (err) {
          const metaErr = err as MetaApiError;
          const retry = metaErr.retryable && attempt < retries;
          log().warn(
            { op: 'phone.media_upload', attempt: attempt + 1, retry, ...metaErrorMeta(metaErr) },
            'meta: request failed',
          );
          if (!retry) throw metaErr;
          await sleep(retryBaseMs * 2 ** attempt + Math.floor(random() * retryBaseMs));
        }
      }
    },

    async getMediaUrl(token, mediaId, phoneNumberId) {
      const raw = await bearer('media.get', 'GET', seg(mediaId), token, mediaUrlSchema, {
        query: { phone_number_id: phoneNumberId },
      });
      return toMediaUrl(raw);
    },

    async downloadMedia(token, url, { maxBytes }) {
      if (!isAllowedMediaUrl(url, options.mediaHosts)) throw mediaRefused('host');
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs * 6),
        });
      } catch (err) {
        const name = (err as Error).name;
        throw networkError(name === 'TimeoutError' || name === 'AbortError');
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw graphError(res.status, null);
      }
      const length = Number(res.headers.get('content-length'));
      const contentLength = Number.isFinite(length) && length > 0 ? length : null;
      if (contentLength !== null && contentLength > maxBytes) {
        await res.body.cancel().catch(() => undefined);
        throw mediaRefused('too_large');
      }
      let seen = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          seen += chunk.length;
          if (seen > maxBytes) done(mediaRefused('too_large'));
          else done(null, chunk);
        },
      });
      const source = Readable.fromWeb(res.body);
      source.on('error', (err) => counter.destroy(err));
      return {
        stream: source.pipe(counter),
        contentType: res.headers.get('content-type'),
        contentLength,
      };
    },

    async blockUsers(token, phoneNumberId, waIds) {
      const raw = await bearer(
        'phone.block_users',
        'POST',
        `${seg(phoneNumberId)}/block_users`,
        token,
        blockUsersSchema,
        { body: { messaging_product: 'whatsapp', block_users: waIds.map((user) => ({ user })) } },
      );
      return toBlockResult(raw);
    },

    async unblockUsers(token, phoneNumberId, waIds) {
      const raw = await bearer(
        'phone.unblock_users',
        'DELETE',
        `${seg(phoneNumberId)}/block_users`,
        token,
        blockUsersSchema,
        { body: { messaging_product: 'whatsapp', block_users: waIds.map((user) => ({ user })) } },
      );
      return toBlockResult(raw);
    },

    async getBusinessProfile(token, phoneNumberId) {
      const raw = await bearer(
        'phone.profile_get',
        'GET',
        `${seg(phoneNumberId)}/whatsapp_business_profile`,
        token,
        businessProfileSchema,
        { query: { fields: PROFILE_FIELDS } },
      );
      return toBusinessProfile(raw);
    },

    async updateBusinessProfile(token, phoneNumberId, fields) {
      const { profilePictureHandle, ...rest } = fields;
      await bearer(
        'phone.profile_update',
        'POST',
        `${seg(phoneNumberId)}/whatsapp_business_profile`,
        token,
        successSchema,
        {
          body: {
            messaging_product: 'whatsapp',
            ...rest,
            ...(profilePictureHandle ? { profile_picture_handle: profilePictureHandle } : {}),
          },
        },
      );
    },

    async uploadProfilePhoto(token, bytes, mimeType) {
      return resumableUpload('app.upload', token, { bytes, mimeType });
    },

    async listTemplates(token, wabaId, opts = {}) {
      const raw = await bearer(
        'waba.templates',
        'GET',
        `${seg(wabaId)}/message_templates`,
        token,
        templateListSchema,
        {
          query: {
            fields: TEMPLATE_FIELDS,
            limit: String(opts.limit ?? 100),
            ...(opts.after ? { after: opts.after } : {}),
          },
        },
      );
      return toTemplatePage(raw);
    },

    async createTemplate(token, wabaId, body) {
      const raw = await bearer(
        'waba.template_create',
        'POST',
        `${seg(wabaId)}/message_templates`,
        token,
        templateCreatedSchema,
        {
          body: {
            name: body.name,
            language: body.language,
            category: body.category,
            parameter_format: body.parameterFormat.toUpperCase(),
            components: body.components,
            ...(body.ttlSeconds ? { message_send_ttl_seconds: body.ttlSeconds } : {}),
          },
        },
      );
      return toTemplateCreated(raw);
    },

    async editTemplate(token, templateId, body) {
      await bearer('template.edit', 'POST', seg(templateId), token, successSchema, {
        body: {
          ...(body.category ? { category: body.category } : {}),
          ...(body.components ? { components: body.components } : {}),
          ...(body.ttlSeconds ? { message_send_ttl_seconds: body.ttlSeconds } : {}),
        },
      });
    },

    async deleteTemplate(token, wabaId, target) {
      await bearer(
        'waba.template_delete',
        'DELETE',
        `${seg(wabaId)}/message_templates`,
        token,
        successSchema,
        { query: { name: target.name, ...(target.hsmId ? { hsm_id: target.hsmId } : {}) } },
      );
    },

    uploadExample(token, file) {
      return resumableUpload('app.example_upload', token, file);
    },

    async getPricingAnalytics(token, wabaId, range) {
      const raw = await bearer(
        'waba.pricing_analytics',
        'GET',
        seg(wabaId),
        token,
        pricingAnalyticsSchema,
        {
          query: {
            fields: `pricing_analytics.start(${unix(range.start)}).end(${unix(range.end)}).granularity(DAILY).dimensions(${PRICING_DIMENSIONS})`,
          },
        },
      );
      return toPricingPoints(raw);
    },

    /* ── Phase 12: calling (SDP goes in the body only — never in logs or errors) ── */

    async startCall(token, phoneNumberId, call) {
      const raw = await bearer(
        'calls.connect',
        'POST',
        `${seg(phoneNumberId)}/calls`,
        token,
        startCallSchema,
        {
          body: {
            messaging_product: 'whatsapp',
            ...(call.to ? { to: call.to } : { recipient: call.recipient }),
            action: 'connect',
            session: { sdp_type: 'offer', sdp: call.sdpOffer },
            ...(call.bizOpaque ? { biz_opaque_callback_data: call.bizOpaque } : {}),
          },
        },
      );
      return { waCallId: raw.calls[0]?.id ?? '' };
    },

    async preAcceptCall(token, phoneNumberId, waCallId, sdpAnswer) {
      await callAction(token, phoneNumberId, 'pre_accept', waCallId, {
        session: { sdp_type: 'answer', sdp: sdpAnswer },
      });
    },

    async acceptCall(token, phoneNumberId, waCallId, sdpAnswer, bizOpaque) {
      await callAction(token, phoneNumberId, 'accept', waCallId, {
        session: { sdp_type: 'answer', sdp: sdpAnswer },
        ...(bizOpaque ? { biz_opaque_callback_data: bizOpaque } : {}),
      });
    },

    async rejectCall(token, phoneNumberId, waCallId) {
      await callAction(token, phoneNumberId, 'reject', waCallId);
    },

    async terminateCall(token, phoneNumberId, waCallId) {
      await callAction(token, phoneNumberId, 'terminate', waCallId);
    },

    async getPhoneSettings(token, phoneNumberId) {
      const raw = await bearer(
        'settings.get',
        'GET',
        `${seg(phoneNumberId)}/settings`,
        token,
        phoneSettingsSchema,
      );
      return toCallingSettings(raw.calling);
    },

    async updateCallingSettings(token, phoneNumberId, calling) {
      await bearer(
        'settings.update',
        'POST',
        `${seg(phoneNumberId)}/settings`,
        token,
        successSchema,
        {
          body: { calling: callingSettingsBody(calling) },
        },
      );
    },

    async getCallAnalytics(token, wabaId, range) {
      // same field-expansion style as pricing_analytics (comma lists, no brackets)
      const raw = await bearer(
        'waba.call_analytics',
        'GET',
        seg(wabaId),
        token,
        callAnalyticsSchema,
        {
          query: {
            fields: `call_analytics.start(${unix(range.start)}).end(${unix(range.end)}).granularity(DAILY).directions(BUSINESS_INITIATED).dimensions(COUNTRY,DIRECTION)`,
          },
        },
      );
      return toCallAnalyticsPoints(raw);
    },

    async getCallPermissions(token, phoneNumberId, waId) {
      const bsuid = !/^\d+$/.test(waId);
      const raw = await bearer(
        'call_permissions.get',
        'GET',
        `${seg(phoneNumberId)}/call_permissions`,
        token,
        callPermissionsSchema,
        { query: bsuid ? { recipient: waId } : { user_wa_id: waId } },
      );
      return toCallPermission(raw);
    },
  };
};
