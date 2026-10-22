import { createHash, randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import { WHATSAPP_LIMITS } from '../../config/limits';

import { graphError, META_ERROR_CODES } from './errors';
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
import type { MetaApiError, MetaClient } from './types';

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
});
export type FakeSignup = z.infer<typeof fakeSignupSchema>;

/** Phone ending → knob (tests / E2E). */
export const FAKE_META_KNOBS = {
  /** Register answers 133005 (a PIN is already set) unless `FAKE_EXISTING_PIN` is used. */
  pinRequiredSuffix: '00001',
  /** Subscribe always fails with a retryable Graph 500. */
  subscribeFailsSuffix: '00002',
} as const;
/** The two-step PIN already set on `…00001` numbers. */
export const FAKE_EXISTING_PIN = '123456';
export const FAKE_SYSTEM_USER_ID = 'fake_system_user_1';
export const FAKE_CREDIT_LINE_ID = 'fake_ecl_1';
const CREDIT_CURRENCIES = new Set(['AUD', 'EUR', 'GBP', 'IDR', 'INR', 'USD']);
const IDENTITY_TTL_SEC = 90 * 24 * 60 * 60;

export const buildFakeCode = (signup: FakeSignup): string =>
  `fake.${Buffer.from(JSON.stringify(signup)).toString('base64url')}`;

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
}

export interface FakeMetaOptions {
  redis: Redis;
  /** Redis key prefix (unique per test file). */
  prefix?: string;
  appSecret: string;
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
}: FakeMetaOptions): FakeMetaClient => {
  const key = (name: string) => `${prefix}fake-meta-${name}`;
  const calls: FakeMetaCall[] = [];
  const failures = new Map<string, MetaApiError[]>();

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
      await redis.set(
        key(`identity-${h}`),
        JSON.stringify({ ...signup, h }),
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
