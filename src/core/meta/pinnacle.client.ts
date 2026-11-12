import { z } from 'zod';

import type { Logger } from '../../shared/logger';

import { isPinnacleFailureBody, mediaRefused, pinnacleError, providerUnsupported } from './errors';
import { createGraphMetaClient, createGraphTransport, seg } from './graph.client';
import {
  businessProfileSchema,
  mediaUrlSchema,
  toBusinessProfile,
  toMediaUrl,
  uploadHandleSchema,
  uploadSessionSchema,
} from './message-schemas';
import { phoneListSchema, phoneSchema, successSchema, toPhone, toPhoneSummaries } from './schemas';
import type { MetaClient, MetaUploadFile } from './types';

/**
 * PN: the Pinnacle partner API (`https://partnersv1.pinbot.ai/v3/…`). It relays Meta's
 * Graph API for numbers onboarded at Pinnacle ("managed numbers"): same paths and bodies,
 * the WABA's API key in an `apikey` header instead of a Bearer token, its own error body
 * (`{ code, status: "failed", message }`, sometimes with HTTP 200), a few paths of its own
 * (`business/…`, `downloadMedia/…`, `app/uploads`) and three extras: key check
 * (`getuserdetails`) and the callback URL (`setwebhook` / `getwebhook`).
 */

/** One number an API key may use (`getuserdetails`). */
export interface PinnacleUserNumber {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
}

export interface PinnacleWebhook {
  url: string;
  headers: Record<string, string>;
}

export interface PinnacleExtras {
  readonly provider: 'pinnacle';
  /** The numbers this key may use; an invalid key throws (`tokenInvalid`). */
  getUserDetails(apiKey: string): Promise<PinnacleUserNumber[]>;
  /** Pinnacle relays Meta's callbacks for the number to `url` with `headers`. */
  setWebhook(
    apiKey: string,
    phoneNumberId: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<void>;
  /** The callback set for the number (`null` when none). */
  getWebhook(apiKey: string, phoneNumberId: string): Promise<PinnacleWebhook | null>;
}

export type PinnacleClient = Omit<MetaClient, 'provider'> & PinnacleExtras;

export interface PinnacleClientOptions {
  baseUrl: string;
  /** WhatsApp Voice wrapper host (default: `baseUrl`). */
  voiceBaseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retries?: number;
  retryBaseMs?: number;
}

/** Pinnacle's version segment. */
export const PINNACLE_API_VERSION = 'v3';

/** `MetaClient` methods a managed number never uses (Meta-app / our credit line only). */
export const PINNACLE_UNSUPPORTED = [
  'exchangeCode',
  'debugToken',
  'listOwnedWabas',
  'listBusinessesWithWabas',
  'subscribeApp',
  'unsubscribeApp',
  'getAppSubscriptions',
  'getTokenOwner',
  'assignSystemUser',
  'attachCreditLine',
  'getAllocation',
  'requestCoexistenceSync',
  'getPricingAnalytics',
  'getCallAnalytics',
] as const satisfies readonly (keyof MetaClient)[];

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

const PROFILE_FIELDS = [
  'about',
  'address',
  'description',
  'email',
  'profile_picture_url',
  'websites',
  'vertical',
].join(',');

const userDetailsSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        whatsapp_business_account_id: z.union([z.string(), z.number()]).transform(String),
        phone_number_id: z.union([z.string(), z.number()]).transform(String),
        wanumber: z.string().nullish(),
      }),
    )
    .default([]),
});

const setWebhookSchema = z.looseObject({
  status: z.string().optional(),
  success: z.boolean().optional(),
});

const getWebhookSchema = z.looseObject({
  webhook_url: z.string().nullish(),
  headers: z.record(z.string(), z.unknown()).nullish(),
});

const stringHeaders = (raw: Record<string, unknown> | null | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(raw ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );

export const createPinnacleClient = (options: PinnacleClientOptions): PinnacleClient => {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const voiceBaseUrl = (options.voiceBaseUrl ?? baseUrl).replace(/\/+$/, '');
  const host = new URL(baseUrl).host.toLowerCase();
  const common = {
    graphVersion: PINNACLE_API_VERSION,
    auth: 'apikey' as const,
    mapError: pinnacleError,
    failureBody: isPinnacleFailureBody,
    label: 'pinnacle',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
  };
  // the Graph client does every call whose path and body Pinnacle relays unchanged
  const relay = createGraphMetaClient({ ...common, appId: '', appSecret: '', baseUrl });
  const voice = createGraphMetaClient({
    ...common,
    appId: '',
    appSecret: '',
    baseUrl: voiceBaseUrl,
  });
  const { bearer, streamMedia } = createGraphTransport({ ...common, baseUrl });

  /** Pinnacle's resumable upload: `app/uploads` session, then the bytes → handle. */
  const resumableUpload = async (op: string, apiKey: string, file: MetaUploadFile) => {
    const session = await bearer(
      `${op}_session`,
      'POST',
      'app/uploads',
      apiKey,
      uploadSessionSchema,
      {
        query: {
          ...(file.fileName ? { file_name: file.fileName } : {}),
          file_length: String(file.bytes.length),
          file_type: file.mimeType,
        },
      },
    );
    const raw = await bearer(op, 'POST', session.id, apiKey, uploadHandleSchema, {
      bytes: file.bytes,
      headers: { file_offset: '0', 'content-type': file.mimeType },
    });
    return raw.h;
  };

  /** Our own media "URL": Pinnacle's direct download for that media id. */
  const downloadUrl = (mediaId: string, phoneNumberId: string) => {
    const url = new URL(`${baseUrl}/${PINNACLE_API_VERSION}/downloadMedia/${seg(mediaId)}`);
    url.searchParams.set('phone_number_id', phoneNumberId);
    return url.toString();
  };

  const unsupported = Object.fromEntries(
    PINNACLE_UNSUPPORTED.map((name) => [name, () => Promise.reject(providerUnsupported(name))]),
  ) as unknown as Pick<MetaClient, (typeof PINNACLE_UNSUPPORTED)[number]>;

  return {
    ...unsupported,
    provider: 'pinnacle',

    // ── same paths and bodies as Graph ──
    getWaba: (key, wabaId) => relay.getWaba(key, wabaId),
    registerPhone: (key, phoneNumberId, pin) => relay.registerPhone(key, phoneNumberId, pin),
    sendMessage: (key, phoneNumberId, payload) => relay.sendMessage(key, phoneNumberId, payload),
    markRead: (key, phoneNumberId, waMessageId, opts) =>
      relay.markRead(key, phoneNumberId, waMessageId, opts),
    uploadMedia: (key, phoneNumberId, media) => relay.uploadMedia(key, phoneNumberId, media),
    blockUsers: (key, phoneNumberId, waIds) => relay.blockUsers(key, phoneNumberId, waIds),
    unblockUsers: (key, phoneNumberId, waIds) => relay.unblockUsers(key, phoneNumberId, waIds),
    listTemplates: (key, wabaId, opts) => relay.listTemplates(key, wabaId, opts),
    createTemplate: (key, wabaId, body) => relay.createTemplate(key, wabaId, body),
    editTemplate: (key, templateId, body) => relay.editTemplate(key, templateId, body),
    deleteTemplate: (key, wabaId, target) => relay.deleteTemplate(key, wabaId, target),
    getPhoneSettings: (key, phoneNumberId) => relay.getPhoneSettings(key, phoneNumberId),
    updateCallingSettings: (key, phoneNumberId, calling) =>
      relay.updateCallingSettings(key, phoneNumberId, calling),
    getCallPermissions: (key, phoneNumberId, waId) =>
      relay.getCallPermissions(key, phoneNumberId, waId),

    // ── calls: the WhatsApp Voice wrapper host ──
    startCall: (key, phoneNumberId, call) => voice.startCall(key, phoneNumberId, call),
    preAcceptCall: (key, phoneNumberId, waCallId, sdp) =>
      voice.preAcceptCall(key, phoneNumberId, waCallId, sdp),
    acceptCall: (key, phoneNumberId, waCallId, sdp, bizOpaque) =>
      voice.acceptCall(key, phoneNumberId, waCallId, sdp, bizOpaque),
    rejectCall: (key, phoneNumberId, waCallId) => voice.rejectCall(key, phoneNumberId, waCallId),
    terminateCall: (key, phoneNumberId, waCallId) =>
      voice.terminateCall(key, phoneNumberId, waCallId),

    // ── Pinnacle's `business/…` paths ──
    async listPhoneNumbers(key, wabaId) {
      const raw = await bearer(
        'waba.phone_numbers',
        'GET',
        `business/${seg(wabaId)}/phone_numbers`,
        key,
        phoneListSchema,
        { query: { fields: 'id,display_phone_number,verified_name,status' } },
      );
      return toPhoneSummaries(raw);
    },

    async getPhoneNumber(key, phoneNumberId) {
      const raw = await bearer(
        'phone.get',
        'GET',
        `business/${seg(phoneNumberId)}`,
        key,
        phoneSchema,
        {
          query: { fields: PHONE_FIELDS },
        },
      );
      return toPhone(raw);
    },

    async getBusinessProfile(key, phoneNumberId) {
      const raw = await bearer(
        'phone.profile_get',
        'GET',
        `business/${seg(phoneNumberId)}/whatsapp_business_profile`,
        key,
        businessProfileSchema,
        { query: { fields: PROFILE_FIELDS } },
      );
      return toBusinessProfile(raw);
    },

    async updateBusinessProfile(key, phoneNumberId, fields) {
      const { profilePictureHandle, ...rest } = fields;
      await bearer(
        'phone.profile_update',
        'POST',
        `business/${seg(phoneNumberId)}/whatsapp_business_profile`,
        key,
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

    uploadProfilePhoto: (key, bytes, mimeType) =>
      resumableUpload('app.upload', key, { bytes, mimeType }),
    uploadExample: (key, file) => resumableUpload('app.example_upload', key, file),

    // ── media: metadata from Pinnacle, bytes from its direct download ──
    async getMediaUrl(key, mediaId, phoneNumberId) {
      const raw = await bearer('media.get', 'GET', seg(mediaId), key, mediaUrlSchema, {
        query: { phone_number_id: phoneNumberId },
      });
      return { ...toMediaUrl(raw), url: downloadUrl(mediaId, phoneNumberId) };
    },

    async downloadMedia(key, url, { maxBytes }) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw mediaRefused('host');
      }
      if (
        parsed.host.toLowerCase() !== host ||
        !parsed.pathname.startsWith(`/${PINNACLE_API_VERSION}/downloadMedia/`)
      ) {
        throw mediaRefused('host');
      }
      return streamMedia(parsed.toString(), { apikey: key }, maxBytes, 'POST');
    },

    // ── Pinnacle extras ──
    async getUserDetails(apiKey) {
      const raw = await bearer('user.details', 'GET', 'getuserdetails', apiKey, userDetailsSchema);
      return raw.data.map((d) => ({
        wabaId: d.whatsapp_business_account_id,
        phoneNumberId: d.phone_number_id,
        displayPhoneNumber: d.wanumber ?? null,
      }));
    },

    async setWebhook(apiKey, phoneNumberId, url, headers) {
      await bearer(
        'webhook.set',
        'POST',
        `${seg(phoneNumberId)}/setwebhook`,
        apiKey,
        setWebhookSchema,
        { body: { webhook_url: url, headers } },
      );
    },

    async getWebhook(apiKey, phoneNumberId) {
      const raw = await bearer(
        'webhook.get',
        'GET',
        `${seg(phoneNumberId)}/getwebhook`,
        apiKey,
        getWebhookSchema,
      );
      const url = raw.webhook_url?.trim();
      return url ? { url, headers: stringHeaders(raw.headers) } : null;
    },
  };
};
