import { createHash, randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import { pinnacleError, providerUnsupported } from './errors';
import { buildFakeCode, FAKE_EXISTING_PIN, fakeIds, type FakeMetaClient } from './fake.client';
import {
  PINNACLE_UNSUPPORTED,
  type PinnacleClient,
  type PinnacleUserNumber,
  type PinnacleWebhook,
} from './pinnacle.client';
import { isMetaApiError, type MetaApiError, type MetaClient } from './types';

/**
 * PN: in-process Pinnacle for dev / tests / E2E (D5). It wraps the fake Meta client:
 * a managed number is a fake Meta identity whose API key (`pin_test_…`) maps to the fake
 * Meta token in Redis, so messages, templates and calls simulate exactly as for Meta.
 * Knobs by key prefix: `pin_bad_…` → invalid key; `pin_low_…` → sends and calls fail
 * with "Insufficient Balance". Callback settings live in Redis.
 */

export const FAKE_PINNACLE_KEY_PREFIXES = {
  valid: 'pin_test_',
  invalid: 'pin_bad_',
  balanceLow: 'pin_low_',
} as const;

export interface FakePinnacleCall {
  op: string;
  target: string | null;
}

export interface FakeManagedNumber extends PinnacleUserNumber {
  apiKey: string;
}

export interface FakePinnacleClient extends PinnacleClient {
  readonly fake: true;
  /** Every call (op + phone / WABA id) — tests assert routing on it. */
  readonly calls: FakePinnacleCall[];
  /** The next call of `op` throws `error` (default: a Pinnacle `status: failed`). */
  failNext(op: keyof PinnacleClient, error?: MetaApiError): void;
  /** Test knob: `setwebhook` answers success but stores nothing (echo mismatch). */
  ignoreWebhookWrites(on: boolean): void;
  /** Creates a fake number at "Pinnacle" and its API key (`pin_test_` unless `keyPrefix`). */
  seedManagedNumber(input: {
    businessName: string;
    phone: string;
    displayName?: string;
    keyPrefix?: string;
  }): Promise<FakeManagedNumber>;
  /** Simulates the partner changing the callback in its panel. */
  overwriteWebhook(phoneNumberId: string, webhook: PinnacleWebhook | null): Promise<void>;
}

const invalidKey = () =>
  pinnacleError(401, { code: 401, status: 'failed', message: 'Invalid API key' }) as MetaApiError;
const balanceLow = () =>
  pinnacleError(200, {
    code: 100,
    status: 'failed',
    message: 'Insufficient Balance',
  }) as MetaApiError;
const partnerFailed = () =>
  pinnacleError(200, {
    code: 100,
    status: 'failed',
    message: 'Partner request failed',
  }) as MetaApiError;

export const createFakePinnacleClient = (
  meta: FakeMetaClient,
  redis: Redis,
  prefix = '',
): FakePinnacleClient => {
  const key = (name: string) => `${prefix}fake-pinnacle-${name}`;
  const keyHash = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex');
  const calls: FakePinnacleCall[] = [];
  const failures = new Map<string, MetaApiError[]>();
  let ignoreWrites = false;

  const track = (op: string, target: string | null) => {
    calls.push({ op, target });
    const queued = failures.get(op)?.shift();
    if (queued) throw queued;
  };

  /** API key → the fake Meta token behind it. */
  const tokenOf = async (apiKey: string): Promise<string> => {
    if (apiKey.startsWith(FAKE_PINNACLE_KEY_PREFIXES.invalid)) throw invalidKey();
    const token = await redis.get(key(`key-${keyHash(apiKey)}`));
    if (!token) throw invalidKey();
    return token;
  };

  /** Every relayed `MetaClient` method: key → token, then the fake Meta. */
  const relay =
    <K extends keyof MetaClient>(op: K, balanceChecked = false) =>
    async (...args: unknown[]): Promise<unknown> => {
      const [apiKey, target, ...rest] = args as [string, string | undefined, ...unknown[]];
      track(op, typeof target === 'string' ? target : null);
      const token = await tokenOf(apiKey);
      if (balanceChecked && apiKey.startsWith(FAKE_PINNACLE_KEY_PREFIXES.balanceLow)) {
        throw balanceLow();
      }
      const fn = meta[op] as unknown as (...a: unknown[]) => Promise<unknown>;
      return fn.call(meta, token, ...(target === undefined ? [] : [target]), ...rest);
    };

  const unsupported = Object.fromEntries(
    PINNACLE_UNSUPPORTED.map((name) => [
      name,
      () => {
        calls.push({ op: name, target: null });
        return Promise.reject(providerUnsupported(name));
      },
    ]),
  );

  const client = {
    ...unsupported,
    provider: 'pinnacle' as const,
    fake: true as const,
    calls,
    getWaba: relay('getWaba'),
    listPhoneNumbers: relay('listPhoneNumbers'),
    getPhoneNumber: relay('getPhoneNumber'),
    registerPhone: relay('registerPhone'),
    sendMessage: relay('sendMessage', true),
    markRead: relay('markRead'),
    uploadMedia: relay('uploadMedia'),
    getMediaUrl: relay('getMediaUrl'),
    blockUsers: relay('blockUsers'),
    unblockUsers: relay('unblockUsers'),
    getBusinessProfile: relay('getBusinessProfile'),
    updateBusinessProfile: relay('updateBusinessProfile'),
    listTemplates: relay('listTemplates'),
    createTemplate: relay('createTemplate'),
    editTemplate: relay('editTemplate'),
    deleteTemplate: relay('deleteTemplate'),
    startCall: relay('startCall', true),
    preAcceptCall: relay('preAcceptCall'),
    acceptCall: relay('acceptCall'),
    rejectCall: relay('rejectCall'),
    terminateCall: relay('terminateCall'),
    getPhoneSettings: relay('getPhoneSettings'),
    updateCallingSettings: relay('updateCallingSettings'),
    getCallPermissions: relay('getCallPermissions'),

    // the fake Meta's media / upload calls take no id as 2nd argument
    async downloadMedia(apiKey: string, url: string, opts: { maxBytes: number }) {
      track('downloadMedia', null);
      return meta.downloadMedia(await tokenOf(apiKey), url, opts);
    },
    async uploadProfilePhoto(apiKey: string, bytes: Buffer, mimeType: string) {
      track('uploadProfilePhoto', null);
      return meta.uploadProfilePhoto(await tokenOf(apiKey), bytes, mimeType);
    },
    async uploadExample(apiKey: string, file: Parameters<MetaClient['uploadExample']>[1]) {
      track('uploadExample', null);
      return meta.uploadExample(await tokenOf(apiKey), file);
    },

    async getUserDetails(apiKey: string): Promise<PinnacleUserNumber[]> {
      track('getUserDetails', null);
      const raw = await redis.get(key(`numbers-${keyHash(apiKey)}`));
      await tokenOf(apiKey);
      return raw ? (JSON.parse(raw) as PinnacleUserNumber[]) : [];
    },

    async setWebhook(
      apiKey: string,
      phoneNumberId: string,
      url: string,
      headers: Record<string, string>,
    ) {
      track('setWebhook', phoneNumberId);
      await tokenOf(apiKey);
      if (ignoreWrites) return;
      if (!url) {
        await redis.del(key(`webhook-${phoneNumberId}`));
        return;
      }
      await redis.set(key(`webhook-${phoneNumberId}`), JSON.stringify({ url, headers }));
    },

    async getWebhook(apiKey: string, phoneNumberId: string): Promise<PinnacleWebhook | null> {
      track('getWebhook', phoneNumberId);
      await tokenOf(apiKey);
      const raw = await redis.get(key(`webhook-${phoneNumberId}`));
      return raw ? (JSON.parse(raw) as PinnacleWebhook) : null;
    },

    failNext(op: keyof PinnacleClient, error: MetaApiError = partnerFailed()) {
      failures.set(op, [...(failures.get(op) ?? []), error]);
    },

    ignoreWebhookWrites(on: boolean) {
      ignoreWrites = on;
    },

    async overwriteWebhook(phoneNumberId: string, webhook: PinnacleWebhook | null) {
      if (webhook) await redis.set(key(`webhook-${phoneNumberId}`), JSON.stringify(webhook));
      else await redis.del(key(`webhook-${phoneNumberId}`));
    },

    async seedManagedNumber(input: {
      businessName: string;
      phone: string;
      displayName?: string;
      keyPrefix?: string;
    }): Promise<FakeManagedNumber> {
      const { accessToken } = await meta.exchangeCode(
        buildFakeCode({
          businessName: input.businessName,
          phone: input.phone,
          displayName: input.displayName ?? input.businessName,
          mode: 'cloud_api',
          outcome: 'finish',
        }),
      );
      const ids = fakeIds(input.businessName, input.phone);
      // Pinnacle registered the number at onboarding
      try {
        await meta.registerPhone(accessToken, ids.phoneNumberId, '246810');
      } catch (err) {
        if (!isMetaApiError(err)) throw err;
        await meta.registerPhone(accessToken, ids.phoneNumberId, FAKE_EXISTING_PIN);
      }
      const apiKey = `${input.keyPrefix ?? FAKE_PINNACLE_KEY_PREFIXES.valid}${randomBytes(12).toString('hex')}`;
      const number: PinnacleUserNumber = {
        wabaId: ids.wabaId,
        phoneNumberId: ids.phoneNumberId,
        displayPhoneNumber: input.phone,
      };
      await redis.set(key(`key-${keyHash(apiKey)}`), accessToken);
      await redis.set(key(`numbers-${keyHash(apiKey)}`), JSON.stringify([number]));
      return { ...number, apiKey };
    },
  };
  return client as unknown as FakePinnacleClient;
};
