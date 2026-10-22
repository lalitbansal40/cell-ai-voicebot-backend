import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import { WHATSAPP_LIMITS } from '../../config/limits';

import { graphError, mediaRefused, META_ERROR_CODES } from './errors';
import {
  blockUsersSchema,
  businessProfileSchema,
  mediaUrlSchema,
  sendMessageSchema,
  toBlockResult,
  toBusinessProfile,
  toMediaUrl,
} from './message-schemas';
import {
  allocationSchema,
  businessesSchema,
  creditLineAttachSchema,
  debugTokenSchema,
  oauthTokenSchema,
  ownedWabasSchema,
  phoneListSchema,
  phoneSchema,
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
import type {
  MetaApiError,
  MetaBusinessProfileUpdate,
  MetaClient,
  MetaMessagePayload,
} from './types';

/** What the Test signup dialog encodes in a fake code (`fake.<base64url JSON>`). */
export const fakeSignupSchema = z.object({
  businessName: z.string().trim().min(1).max(100),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s-]{8,20}$/),
  displayName: z.string().trim().min(1).max(100),
  mode: z.enum(['cloud_api', 'coexistence']),
  outcome: z.enum(['finish', 'only_waba', 'cancel', 'error']),
  /** Makes every code unique (Meta codes are single use). */
  nonce: z.string().max(40).optional(),
});
export type FakeSignup = z.infer<typeof fakeSignupSchema>;

/** Phone ending → knob (tests / E2E). */
export const FAKE_META_KNOBS = {
  /** Register answers 133005 (a PIN is already set) unless `FAKE_EXISTING_PIN` is used. */
  pinRequiredSuffix: '00001',
  /** Subscribe always fails with a retryable Graph 500. */
  subscribeFailsSuffix: '00002',
} as const;

/** Customer number ending → inbox behaviour (tests / E2E — PHASE_10 prompt §1). */
export const FAKE_INBOX_KNOBS = {
  /** Block / unblock refused (the customer didn't message in the last 24 h). */
  blockFails: '00005',
  /** Throughput error 130429 twice, then accepted (retry path). */
  throughputTwice: '00006',
  /** Send refused: 131047 (window closed at Meta). */
  windowClosed: '00007',
  /** Statuses stop at delivered (never read). */
  neverRead: '00008',
  /** Sent, then failed 131026 (undeliverable). */
  undeliverable: '00009',
} as const;

/** One send the fake recorded (no texts, no full numbers). */
export interface FakeSentMessage {
  waMessageId: string;
  phoneNumberId: string;
  toLast4: string;
  type: string;
  interactiveType: string | null;
  mediaId: string | null;
  replyTo: boolean;
  /** Audio sends: the uploaded bytes are a mono OGG / Opus file. */
  voiceValid: boolean | null;
  at: string;
}

export interface FakeReadReceipt {
  waMessageId: string;
  typing: boolean;
  at: string;
}

const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const MEDIA_TTL_SEC = 24 * 60 * 60;
const MEDIA_URL_TTL_SEC = 300;
const LOG_MAX = 500;

/** Mono OGG / Opus (what WhatsApp plays as a voice message). */
export const isMonoOggOpus = (bytes: Buffer): boolean => {
  if (bytes.length < 47 || bytes.toString('latin1', 0, 4) !== 'OggS') return false;
  const head = bytes.indexOf('OpusHead', 0, 'latin1');
  return head >= 0 && head < 64 && bytes[head + 9] === 1;
};

/** HMAC of a fake media URL (`<id>.<exp>`). */
export const fakeMediaSignature = (appSecret: string, mediaId: string, exp: number): string =>
  createHmac('sha256', appSecret)
    .update(`${mediaId}.${String(exp)}`)
    .digest('hex');

export const verifyFakeMediaSignature = (
  appSecret: string,
  mediaId: string,
  exp: number,
  sig: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean => {
  if (!/^[0-9a-f]{64}$/.test(sig) || !Number.isFinite(exp) || exp < nowSec) return false;
  return timingSafeEqual(
    Buffer.from(fakeMediaSignature(appSecret, mediaId, exp), 'hex'),
    Buffer.from(sig, 'hex'),
  );
};
/** The two-step PIN already set on `…00001` numbers. */
export const FAKE_EXISTING_PIN = '123456';
export const FAKE_SYSTEM_USER_ID = 'fake_system_user_1';
export const FAKE_CREDIT_LINE_ID = 'fake_ecl_1';
const CREDIT_CURRENCIES = new Set(['AUD', 'EUR', 'GBP', 'IDR', 'INR', 'USD']);
const IDENTITY_TTL_SEC = 90 * 24 * 60 * 60;

/** `fake.<base64url JSON>` with a fresh nonce (each code is single use, like Meta's). */
export const buildFakeCode = (signup: FakeSignup): string =>
  `fake.${Buffer.from(JSON.stringify({ nonce: randomBytes(6).toString('hex'), ...signup })).toString('base64url')}`;

const digits = (phone: string) => phone.replace(/\D/g, '');

/** Deterministic ids (same business + phone → same WABA / number → reconnect finds it). */
export const fakeIds = (businessName: string, phone: string) => {
  const h = createHash('sha256')
    .update(`${businessName.trim()}|${digits(phone)}`)
    .digest('hex')
    .slice(0, 12);
  return {
    h,
    wabaId: `fake_waba_${h}`,
    phoneNumberId: `fake_phone_${h}`,
    businessId: `fake_biz_${h}`,
    userId: `fake_user_${h}`,
    allocationConfigId: `fake_alloc_${h}`,
  };
};

type PhonePatch = Partial<
  Record<
    | 'quality_rating'
    | 'messaging_limit_tier'
    | 'name_status'
    | 'new_name_status'
    | 'verified_name'
    | 'status',
    string
  >
>;

export interface FakeMetaCall {
  op: string;
  target: string | null;
}

export interface FakeMetaClient extends MetaClient {
  readonly provider: 'fake';
  readonly appSecret: string;
  /** Every call made (op + WABA / phone id) — tests assert on it. */
  readonly calls: FakeMetaCall[];
  /** The next call of `op` throws `error` (default: a retryable Graph 500). */
  failNext(op: keyof MetaClient, error?: MetaApiError): void;
  revokeToken(token: string): Promise<void>;
  /** `only_waba` signups: the business adds a number in WhatsApp Manager. */
  addPhoneNumber(wabaId: string): Promise<void>;
  /** Customer-paid WABA gets a payment method (`primary_funding_id`). */
  addPaymentMethod(wabaId: string): Promise<void>;
  /** Overrides phone details (quality, tier, name, status) — simulator / health tests. */
  patchPhone(phoneNumberId: string, patch: PhonePatch): Promise<void>;
  isSubscribed(wabaId: string): Promise<boolean>;
  isRegistered(phoneNumberId: string): Promise<boolean>;
  /* ── Phase 10 ── */
  /** Where auto status webhooks go (set at app start: signed + received by the real pipeline). */
  setWebhookEmitter(emit: ((body: Record<string, unknown>) => Promise<unknown>) | null): void;
  /** Cancels pending auto status webhooks (shutdown / tests). */
  stopStatusTimers(): void;
  /** Stores bytes as Meta media (simulator: inbound media) → media id. */
  putMedia(bytes: Buffer, mimeType: string, fileName?: string | null): Promise<string>;
  /** Bytes of a stored media id (dev media route) or null. */
  readMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  deleteMedia(mediaId: string): Promise<void>;
  sentMessages(phoneNumberId: string): Promise<FakeSentMessage[]>;
  readReceipts(phoneNumberId: string): Promise<FakeReadReceipt[]>;
  isBlocked(phoneNumberId: string, waId: string): Promise<boolean>;
}

export interface FakeMetaOptions {
  redis: Redis;
  /** Redis key prefix (unique per test file). */
  prefix?: string;
  appSecret: string;
  /** `[sent, delivered, read]` ms after an accepted send; null / omitted = no auto statuses. */
  statusDelaysMs?: readonly [number, number, number] | null;
  /** Origin of the dev media route (`APP_URL`) — media URLs point there. */
  mediaBaseUrl?: string;
}

interface Identity extends FakeSignup {
  h: string;
}

const fail = (
  status: number,
  code: number,
  message: string,
  subcode?: number,
  type = 'OAuthException',
) =>
  graphError(status, {
    error: {
      message,
      type,
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
      fbtrace_id: 'fake_trace',
    },
  });

const tokenInvalid = () =>
  fail(
    401,
    META_ERROR_CODES.tokenInvalid,
    'Error validating access token: the session has been invalidated',
  );
const notFound = (what: string) =>
  fail(
    400,
    100,
    `Unsupported request — ${what} does not exist or the token can't access it`,
    33,
    'GraphMethodException',
  );

/**
 * Deterministic in-process Meta (dev / tests / E2E). State in Redis so every process
 * (API + worker) sees the same fake WABAs. Responses are Meta-shaped JSON parsed by
 * the same schemas as the Graph client.
 */
export const createFakeMetaClient = ({
  redis,
  prefix = '',
  appSecret,
  statusDelaysMs = null,
  mediaBaseUrl = 'http://localhost:5100',
}: FakeMetaOptions): FakeMetaClient => {
  const key = (name: string) => `${prefix}fake-meta-${name}`;
  const calls: FakeMetaCall[] = [];
  const failures = new Map<string, MetaApiError[]>();
  const timers = new Set<NodeJS.Timeout>();
  let emitter: ((body: Record<string, unknown>) => Promise<unknown>) | null = null;
  const mediaOrigin = new URL(mediaBaseUrl);

  const track = (op: keyof MetaClient, target: string | null) => {
    calls.push({ op, target });
    const queued = failures.get(op)?.shift();
    if (queued) throw queued;
  };

  const loadIdentity = async (h: string): Promise<Identity | null> => {
    const raw = await redis.get(key(`identity-${h}`));
    return raw ? (JSON.parse(raw) as Identity) : null;
  };

  /** Token → identity; unknown / revoked tokens throw Graph 190. */
  const identityOf = async (token: string): Promise<Identity> => {
    const match = /^fake_tok_([0-9a-f]{12})_[0-9a-f]{16}$/.exec(token);
    if (!match?.[1]) throw tokenInvalid();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (await redis.exists(key(`revoked-${tokenHash}`))) throw tokenInvalid();
    const identity = await loadIdentity(match[1]);
    if (!identity) throw tokenInvalid();
    return identity;
  };

  const hOf = (id: string, kind: 'waba' | 'phone' | 'alloc') => {
    const match = new RegExp(`^fake_${kind}_([0-9a-f]{12})$`).exec(id);
    return match?.[1] ?? null;
  };

  /** The identity behind a WABA / phone id, checked against the token's identity. */
  const owned = async (token: string, id: string, kind: 'waba' | 'phone') => {
    const identity = await identityOf(token);
    if (hOf(id, kind) !== identity.h)
      throw notFound(kind === 'waba' ? 'the WhatsApp Business Account' : 'the phone number');
    return identity;
  };

  const hasNumber = async (identity: Identity) =>
    identity.outcome !== 'only_waba' ||
    (await redis.exists(key(`number-added-${identity.h}`))) === 1;

  const rawPhone = async (identity: Identity) => {
    const ids = fakeIds(identity.businessName, identity.phone);
    const registered = (await redis.exists(key(`registered-${ids.phoneNumberId}`))) === 1;
    const patch = (await redis.hgetall(key(`phone-${ids.phoneNumberId}`))) as PhonePatch;
    const coexistence = identity.mode === 'coexistence';
    return {
      id: ids.phoneNumberId,
      display_phone_number: identity.phone.trim(),
      verified_name: identity.displayName,
      name_status: /pending/i.test(identity.displayName) ? 'PENDING_REVIEW' : 'APPROVED',
      quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_1K',
      code_verification_status: 'VERIFIED',
      platform_type: 'CLOUD_API',
      throughput: { level: 'STANDARD' },
      account_mode: 'LIVE',
      status: coexistence || registered ? 'CONNECTED' : 'PENDING',
      is_official_business_account: false,
      is_on_biz_app: coexistence,
      ...patch,
    };
  };

  const pushLog = async (name: string, entry: object) => {
    await redis.lpush(key(name), JSON.stringify(entry));
    await redis.ltrim(key(name), 0, LOG_MAX - 1);
    await redis.expire(key(name), MEDIA_TTL_SEC);
  };

  const storeMedia = async (bytes: Buffer, mimeType: string, fileName: string | null) => {
    const id = `fake_media_${randomBytes(10).toString('hex')}`;
    await redis.set(key(`media-${id}`), bytes, 'EX', MEDIA_TTL_SEC);
    await redis.hset(key(`media-meta-${id}`), {
      mimeType,
      size: String(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('base64'),
      fileName: fileName ?? '',
    });
    await redis.expire(key(`media-meta-${id}`), MEDIA_TTL_SEC);
    return id;
  };

  const loadMedia = async (mediaId: string) => {
    const [bytes, meta] = await Promise.all([
      redis.getBuffer(key(`media-${mediaId}`)),
      redis.hgetall(key(`media-meta-${mediaId}`)),
    ]);
    return bytes && meta.mimeType ? { bytes, mimeType: meta.mimeType } : null;
  };

  const recordSend = async (
    phoneNumberId: string,
    waMessageId: string,
    payload: MetaMessagePayload,
  ) => {
    const part = payload[payload.type] as Record<string, unknown> | undefined;
    const mediaId = typeof part?.id === 'string' ? part.id : null;
    let voiceValid: boolean | null = null;
    if (payload.type === 'audio' && mediaId) {
      const media = await loadMedia(mediaId);
      voiceValid = media ? isMonoOggOpus(media.bytes) : false;
    }
    await pushLog(`sent-${phoneNumberId}`, {
      waMessageId,
      phoneNumberId,
      toLast4: digits(payload.to).slice(-4),
      type: payload.type,
      interactiveType:
        payload.type === 'interactive' && typeof part?.type === 'string' ? part.type : null,
      mediaId,
      replyTo: Boolean(payload.context),
      voiceValid,
      at: new Date().toISOString(),
    } satisfies FakeSentMessage);
  };

  const statusWebhook = (
    identity: Identity,
    phoneNumberId: string,
    waMessageId: string,
    to: string,
    status: string,
  ) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: fakeIds(identity.businessName, identity.phone).wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: digits(identity.phone),
                phone_number_id: phoneNumberId,
              },
              statuses: [
                {
                  id: waMessageId,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: to,
                  conversation: { id: `fake_conv_${to}`, origin: { type: 'service' } },
                  pricing: {
                    billable: false,
                    pricing_model: 'PMP',
                    category: 'service',
                    type: 'free_customer_service',
                  },
                  ...(status === 'failed'
                    ? {
                        errors: [
                          {
                            code: 131026,
                            title: 'Message undeliverable',
                            message: 'Message undeliverable',
                            error_data: { details: 'Message undeliverable' },
                          },
                        ],
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });

  /** sent → delivered → read after the configured delays (knobs change the ending). */
  const scheduleStatuses = (
    identity: Identity,
    phoneNumberId: string,
    waMessageId: string,
    to: string,
  ) => {
    if (!statusDelaysMs) return;
    const plan: string[] = to.endsWith(FAKE_INBOX_KNOBS.undeliverable)
      ? ['sent', 'failed']
      : to.endsWith(FAKE_INBOX_KNOBS.neverRead)
        ? ['sent', 'delivered']
        : ['sent', 'delivered', 'read'];
    plan.forEach((status, i) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void emitter?.(statusWebhook(identity, phoneNumberId, waMessageId, to, status)).catch(
          () => undefined,
        );
      }, statusDelaysMs[i] ?? 0);
      timer.unref();
      timers.add(timer);
    });
  };

  const block = async (phoneNumberId: string, waIds: string[], add: boolean) => {
    const done: { input: string; wa_id: string }[] = [];
    const failed: { input: string; wa_id: string; errors: { code: number; message: string }[] }[] =
      [];
    for (const raw of waIds) {
      const waId = digits(raw);
      if (waId.endsWith(FAKE_INBOX_KNOBS.blockFails)) {
        failed.push({
          input: waId,
          wa_id: waId,
          errors: [
            {
              code: 139100,
              message: 'Failed to block user: the user has not messaged in the last 24 hours',
            },
          ],
        });
        continue;
      }
      if (add) await redis.sadd(key(`blocked-${phoneNumberId}`), waId);
      else await redis.srem(key(`blocked-${phoneNumberId}`), waId);
      done.push({ input: waId, wa_id: waId });
    }
    return toBlockResult(
      blockUsersSchema.parse({
        messaging_product: 'whatsapp',
        block_users: add
          ? { added_users: done, failed_users: failed }
          : { removed_users: done, failed_users: failed },
      }),
    );
  };

  const profile = async (identity: Identity, phoneNumberId: string) => {
    const stored = await redis.get(key(`profile-${phoneNumberId}`));
    return stored
      ? (JSON.parse(stored) as Record<string, unknown>)
      : {
          about: `Hello from ${identity.displayName}`,
          address: null,
          description: null,
          email: null,
          profile_picture_url: null,
          websites: [],
          vertical: 'OTHER',
        };
  };

  return {
    provider: 'fake',
    appSecret,
    calls,

    failNext(op, error) {
      const list = failures.get(op) ?? [];
      list.push(error ?? fail(500, 2, 'Service temporarily unavailable'));
      failures.set(op, list);
    },

    async exchangeCode(code) {
      track('exchangeCode', null);
      const invalid = () =>
        fail(400, 100, 'Error validating verification code', META_ERROR_CODES.codeExpired);
      if (!code.startsWith('fake.')) throw invalid();
      let signup: FakeSignup;
      try {
        signup = fakeSignupSchema.parse(
          JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8')),
        );
      } catch {
        throw invalid();
      }
      const used = await redis.set(
        key(`used-${createHash('sha256').update(code).digest('hex')}`),
        '1',
        'EX',
        WHATSAPP_LIMITS.fakeCodeTtlSec,
        'NX',
      );
      if (used !== 'OK')
        throw fail(400, 100, 'This authorization code has been used', META_ERROR_CODES.codeUsed);
      if (signup.outcome === 'error' || signup.outcome === 'cancel') throw invalid();
      const { h } = fakeIds(signup.businessName, signup.phone);
      const { nonce: _nonce, ...identity } = signup;
      await redis.set(
        key(`identity-${h}`),
        JSON.stringify({ ...identity, h }),
        'EX',
        IDENTITY_TTL_SEC,
      );
      const token = `fake_tok_${h}_${randomBytes(8).toString('hex')}`;
      return toAccessToken(oauthTokenSchema.parse({ access_token: token, token_type: 'bearer' }));
    },

    async debugToken(token) {
      track('debugToken', null);
      let identity: Identity | null = null;
      try {
        identity = await identityOf(token);
      } catch {
        identity = null;
      }
      const ids = identity ? fakeIds(identity.businessName, identity.phone) : null;
      return toDebugToken(
        debugTokenSchema.parse({
          data: {
            app_id: '1000000000000001',
            type: 'SYSTEM_USER',
            application: 'Cell AI (fake)',
            is_valid: Boolean(identity),
            expires_at: 0,
            ...(ids ? { user_id: ids.userId } : {}),
            scopes: identity
              ? [
                  'whatsapp_business_management',
                  'whatsapp_business_messaging',
                  'business_management',
                ]
              : [],
            granular_scopes: ids
              ? [
                  { scope: 'whatsapp_business_management', target_ids: [ids.wabaId] },
                  { scope: 'whatsapp_business_messaging', target_ids: [ids.wabaId] },
                ]
              : [],
          },
        }),
      );
    },

    async listOwnedWabas(token) {
      track('listOwnedWabas', null);
      const identity = await identityOf(token);
      const ids = fakeIds(identity.businessName, identity.phone);
      return toOwnedWabas(
        ownedWabasSchema.parse({ data: [{ id: ids.wabaId, name: identity.businessName }] }),
      );
    },

    async listBusinessesWithWabas(token) {
      track('listBusinessesWithWabas', null);
      const identity = await identityOf(token);
      const ids = fakeIds(identity.businessName, identity.phone);
      return toBusinesses(
        businessesSchema.parse({
          data: [
            {
              id: ids.businessId,
              name: identity.businessName,
              owned_whatsapp_business_accounts: {
                data: [{ id: ids.wabaId, name: identity.businessName }],
              },
            },
          ],
        }),
      );
    },

    async getWaba(token, wabaId) {
      track('getWaba', wabaId);
      const identity = await owned(token, wabaId, 'waba');
      const ids = fakeIds(identity.businessName, identity.phone);
      const funded = (await redis.exists(key(`funded-${wabaId}`))) === 1;
      return toWaba(
        wabaSchema.parse({
          id: wabaId,
          name: identity.businessName,
          currency: /foreign/i.test(identity.businessName) ? 'XYZ' : 'INR',
          timezone_id: '71',
          message_template_namespace: `fake_ns_${ids.h}`,
          account_review_status: 'APPROVED',
          business_verification_status: 'not_verified',
          owner_business_info: { id: ids.businessId, name: identity.businessName },
          ...(funded ? { primary_funding_id: `fake_funding_${ids.h}` } : {}),
        }),
      );
    },

    async listPhoneNumbers(token, wabaId) {
      track('listPhoneNumbers', wabaId);
      const identity = await owned(token, wabaId, 'waba');
      const phone = (await hasNumber(identity)) ? await rawPhone(identity) : null;
      return toPhoneSummaries(
        phoneListSchema.parse({
          data: phone
            ? [
                {
                  id: phone.id,
                  display_phone_number: phone.display_phone_number,
                  verified_name: phone.verified_name,
                  status: phone.status,
                },
              ]
            : [],
        }),
      );
    },

    async getPhoneNumber(token, phoneNumberId) {
      track('getPhoneNumber', phoneNumberId);
      const identity = await owned(token, phoneNumberId, 'phone');
      if (!(await hasNumber(identity))) throw notFound('the phone number');
      return toPhone(phoneSchema.parse(await rawPhone(identity)));
    },

    async subscribeApp(token, wabaId) {
      track('subscribeApp', wabaId);
      const identity = await owned(token, wabaId, 'waba');
      if (digits(identity.phone).endsWith(FAKE_META_KNOBS.subscribeFailsSuffix)) {
        throw fail(500, 2, 'Service temporarily unavailable');
      }
      await redis.set(key(`subscribed-${wabaId}`), '1');
    },

    async unsubscribeApp(token, wabaId) {
      track('unsubscribeApp', wabaId);
      await owned(token, wabaId, 'waba');
      await redis.del(key(`subscribed-${wabaId}`));
    },

    getTokenOwner(token) {
      return Promise.resolve().then(() => {
        track('getTokenOwner', null);
        if (!token) throw tokenInvalid();
        return FAKE_SYSTEM_USER_ID;
      });
    },

    async assignSystemUser(token, wabaId, userId) {
      track('assignSystemUser', wabaId);
      await owned(token, wabaId, 'waba');
      if (userId !== FAKE_SYSTEM_USER_ID) throw notFound('the user');
    },

    async attachCreditLine(wabaId, currency) {
      track('attachCreditLine', wabaId);
      const h = hOf(wabaId, 'waba');
      const identity = h ? await loadIdentity(h) : null;
      if (!identity) throw notFound('the WhatsApp Business Account');
      if (!CREDIT_CURRENCIES.has(currency)) {
        throw fail(
          400,
          100,
          `Currency ${currency} is not supported for credit sharing`,
          undefined,
          'GraphMethodException',
        );
      }
      if (/other partner/i.test(identity.businessName)) {
        throw fail(
          400,
          100,
          "This WhatsApp Business Account is already on another partner's credit line",
          undefined,
          'GraphMethodException',
        );
      }
      await redis.set(key(`funded-${wabaId}`), '1');
      return toCreditLineAttach(
        creditLineAttachSchema.parse({
          allocation_config_id: fakeIds(identity.businessName, identity.phone).allocationConfigId,
          waba_id: wabaId,
        }),
      );
    },

    getAllocation(allocationConfigId) {
      return Promise.resolve().then(() => {
        track('getAllocation', allocationConfigId);
        const h = hOf(allocationConfigId, 'alloc');
        if (!h) throw notFound('the allocation');
        return toAllocation(
          allocationSchema.parse({
            id: allocationConfigId,
            receiving_credential: { id: `fake_cred_${h}` },
          }),
        );
      });
    },

    async registerPhone(token, phoneNumberId, pin) {
      track('registerPhone', phoneNumberId);
      const identity = await owned(token, phoneNumberId, 'phone');
      if (!/^\d{6}$/.test(pin))
        throw fail(400, 100, 'The PIN must be 6 digits', undefined, 'GraphMethodException');
      if (
        digits(identity.phone).endsWith(FAKE_META_KNOBS.pinRequiredSuffix) &&
        pin !== FAKE_EXISTING_PIN
      ) {
        throw fail(
          400,
          META_ERROR_CODES.pinMismatch,
          'Two step verification PIN Mismatch',
          undefined,
          'GraphMethodException',
        );
      }
      await redis.set(key(`registered-${phoneNumberId}`), '1');
    },

    async requestCoexistenceSync(token, phoneNumberId, kind) {
      track('requestCoexistenceSync', phoneNumberId);
      const identity = await owned(token, phoneNumberId, 'phone');
      if (identity.mode !== 'coexistence') {
        throw fail(
          400,
          100,
          'This number is not on the WhatsApp Business app',
          undefined,
          'GraphMethodException',
        );
      }
      return { requestId: `fake_sync_${identity.h}_${kind}` };
    },

    async sendMessage(token, phoneNumberId, payload) {
      track('sendMessage', phoneNumberId);
      const identity = await owned(token, phoneNumberId, 'phone');
      const to = digits(payload.to);
      if (to.endsWith(FAKE_INBOX_KNOBS.windowClosed)) {
        throw fail(
          400,
          131047,
          'Re-engagement message: more than 24 hours have passed since the customer last replied',
          undefined,
          'OAuthException',
        );
      }
      if (to.endsWith(FAKE_INBOX_KNOBS.throughputTwice)) {
        const k = key(`throughput-${phoneNumberId}-${to}`);
        const n = await redis.incr(k);
        await redis.expire(k, 600);
        if (n <= 2) throw fail(400, 130429, 'Rate limit hit', undefined, 'OAuthException');
        await redis.del(k);
      }
      const waMessageId = `wamid.FAKE${randomBytes(12).toString('hex').toUpperCase()}`;
      await recordSend(phoneNumberId, waMessageId, payload);
      scheduleStatuses(identity, phoneNumberId, waMessageId, to);
      return {
        waMessageId:
          sendMessageSchema.parse({ messages: [{ id: waMessageId }] }).messages[0]?.id ??
          waMessageId,
      };
    },

    async markRead(token, phoneNumberId, waMessageId, opts = {}) {
      track('markRead', phoneNumberId);
      await owned(token, phoneNumberId, 'phone');
      await pushLog(`read-${phoneNumberId}`, {
        waMessageId,
        typing: Boolean(opts.typing),
        at: new Date().toISOString(),
      } satisfies FakeReadReceipt);
    },

    async uploadMedia(token, phoneNumberId, media) {
      track('uploadMedia', phoneNumberId);
      await owned(token, phoneNumberId, 'phone');
      if (media.bytes.length > MEDIA_MAX_BYTES) {
        throw fail(400, 131053, 'Media upload error: file too large', undefined, 'OAuthException');
      }
      return storeMedia(media.bytes, media.mimeType, media.fileName);
    },

    async getMediaUrl(token, mediaId, phoneNumberId) {
      track('getMediaUrl', mediaId);
      await owned(token, phoneNumberId, 'phone');
      const meta = await redis.hgetall(key(`media-meta-${mediaId}`));
      if (!meta.mimeType) throw notFound('the media');
      const exp = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SEC;
      const url = new URL(`/api/v1/dev/meta/media/${mediaId}`, mediaOrigin);
      url.searchParams.set('exp', String(exp));
      url.searchParams.set('sig', fakeMediaSignature(appSecret, mediaId, exp));
      return toMediaUrl(
        mediaUrlSchema.parse({
          url: url.toString(),
          mime_type: meta.mimeType,
          sha256: meta.sha256,
          file_size: Number(meta.size),
          id: mediaId,
        }),
      );
    },

    async downloadMedia(token, url, { maxBytes }) {
      track('downloadMedia', null);
      await identityOf(token);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw mediaRefused('host');
      }
      if (parsed.origin !== mediaOrigin.origin) throw mediaRefused('host');
      const id = /^\/api\/v1\/dev\/meta\/media\/([\w-]+)$/.exec(parsed.pathname)?.[1];
      const exp = Number(parsed.searchParams.get('exp'));
      if (
        !id ||
        !verifyFakeMediaSignature(appSecret, id, exp, parsed.searchParams.get('sig') ?? '')
      ) {
        throw graphError(403, null);
      }
      const media = await loadMedia(id);
      if (!media) throw graphError(404, null);
      if (media.bytes.length > maxBytes) throw mediaRefused('too_large');
      return {
        stream: Readable.from([media.bytes]),
        contentType: media.mimeType,
        contentLength: media.bytes.length,
      };
    },

    async blockUsers(token, phoneNumberId, waIds) {
      track('blockUsers', phoneNumberId);
      await owned(token, phoneNumberId, 'phone');
      return block(phoneNumberId, waIds, true);
    },

    async unblockUsers(token, phoneNumberId, waIds) {
      track('unblockUsers', phoneNumberId);
      await owned(token, phoneNumberId, 'phone');
      return block(phoneNumberId, waIds, false);
    },

    async getBusinessProfile(token, phoneNumberId) {
      track('getBusinessProfile', phoneNumberId);
      const identity = await owned(token, phoneNumberId, 'phone');
      return toBusinessProfile(
        businessProfileSchema.parse({ data: [await profile(identity, phoneNumberId)] }),
      );
    },

    async updateBusinessProfile(token, phoneNumberId, fields: MetaBusinessProfileUpdate) {
      track('updateBusinessProfile', phoneNumberId);
      const identity = await owned(token, phoneNumberId, 'phone');
      const current = await profile(identity, phoneNumberId);
      const { profilePictureHandle, ...rest } = fields;
      if (profilePictureHandle !== undefined && !profilePictureHandle.startsWith('fake_handle_')) {
        throw fail(400, 100, 'Invalid profile picture handle', undefined, 'GraphMethodException');
      }
      const next = {
        ...current,
        ...rest,
        ...(profilePictureHandle
          ? { profile_picture_url: `https://fake.fbcdn.net/profile/${profilePictureHandle}.jpg` }
          : {}),
      };
      await redis.set(
        key(`profile-${phoneNumberId}`),
        JSON.stringify(next),
        'EX',
        IDENTITY_TTL_SEC,
      );
    },

    async uploadProfilePhoto(token, bytes, mimeType) {
      track('uploadProfilePhoto', null);
      await identityOf(token);
      if (!['image/jpeg', 'image/png'].includes(mimeType) || bytes.length === 0) {
        throw fail(400, 100, 'Unsupported file type', undefined, 'GraphMethodException');
      }
      return `fake_handle_${randomBytes(8).toString('hex')}`;
    },

    setWebhookEmitter(emit) {
      emitter = emit;
    },

    stopStatusTimers() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },

    putMedia(bytes, mimeType, fileName = null) {
      return storeMedia(bytes, mimeType, fileName);
    },

    readMedia(mediaId) {
      return loadMedia(mediaId);
    },

    async deleteMedia(mediaId) {
      await redis.del(key(`media-${mediaId}`), key(`media-meta-${mediaId}`));
    },

    async sentMessages(phoneNumberId) {
      return (await redis.lrange(key(`sent-${phoneNumberId}`), 0, -1))
        .map((raw) => JSON.parse(raw) as FakeSentMessage)
        .reverse();
    },

    async readReceipts(phoneNumberId) {
      return (await redis.lrange(key(`read-${phoneNumberId}`), 0, -1))
        .map((raw) => JSON.parse(raw) as FakeReadReceipt)
        .reverse();
    },

    async isBlocked(phoneNumberId, waId) {
      return (await redis.sismember(key(`blocked-${phoneNumberId}`), digits(waId))) === 1;
    },

    async revokeToken(token) {
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await redis.set(key(`revoked-${tokenHash}`), '1', 'EX', IDENTITY_TTL_SEC);
    },

    async addPhoneNumber(wabaId) {
      const h = hOf(wabaId, 'waba');
      if (h) await redis.set(key(`number-added-${h}`), '1', 'EX', IDENTITY_TTL_SEC);
    },

    async addPaymentMethod(wabaId) {
      await redis.set(key(`funded-${wabaId}`), '1');
    },

    async patchPhone(phoneNumberId, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length)
        await redis.hset(key(`phone-${phoneNumberId}`), Object.fromEntries(entries));
    },

    async isSubscribed(wabaId) {
      return (await redis.exists(key(`subscribed-${wabaId}`))) === 1;
    },

    async isRegistered(phoneNumberId) {
      return (await redis.exists(key(`registered-${phoneNumberId}`))) === 1;
    },
  };
};
