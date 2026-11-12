import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createFakeMetaClient,
  createFakePinnacleClient,
  createPinnacleFromEnv,
  FAKE_PINNACLE_KEY_PREFIXES,
  isProviderBalanceLow,
  isProviderUnsupported,
  type FakeMetaClient,
  type FakePinnacleClient,
} from '../../src/core/meta';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { testEnv } from '../helpers/test-app';

let redis: Redis;
let meta: FakeMetaClient;
let pin: FakePinnacleClient;
const prefix = uniquePrefix('fake-pinnacle');

beforeAll(async () => {
  redis = (await requireRedis()).client;
  meta = createFakeMetaClient({ redis, prefix, appSecret: 'fake-secret' });
  pin = createFakePinnacleClient(meta, redis, prefix);
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

let n = 0;
const seed = (keyPrefix?: string) => {
  n += 1;
  return pin.seedManagedNumber({
    businessName: `Managed Biz ${String(n)} ${prefix}`,
    phone: `+91 98000 1${String(n).padStart(4, '0')}`,
    ...(keyPrefix ? { keyPrefix } : {}),
  });
};

describe('fake Pinnacle (PN D5)', () => {
  it('seeds a registered managed number whose pin_test_ key lists it', async () => {
    const num = await seed();
    expect(num.apiKey.startsWith(FAKE_PINNACLE_KEY_PREFIXES.valid)).toBe(true);
    expect(await pin.getUserDetails(num.apiKey)).toEqual([
      {
        wabaId: num.wabaId,
        phoneNumberId: num.phoneNumberId,
        displayPhoneNumber: expect.any(String),
      },
    ]);
    const phone = await pin.getPhoneNumber(num.apiKey, num.phoneNumberId);
    expect(phone.status).toBe('CONNECTED');
    expect((await pin.getWaba(num.apiKey, num.wabaId)).currency).toBe('INR');
    expect(pin.calls.some((c) => c.op === 'getPhoneNumber')).toBe(true);
  });

  it('relays sends to the fake Meta (same messages, same ids)', async () => {
    const num = await seed();
    const { waMessageId } = await pin.sendMessage(num.apiKey, num.phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919000000001',
      type: 'text',
      text: { body: 'hi' },
    } as never);
    expect(waMessageId).toBeTruthy();
    expect(await meta.sentMessages(num.phoneNumberId)).toHaveLength(1);
  });

  it('unknown and pin_bad_ keys are rejected as an invalid key', async () => {
    await expect(pin.getUserDetails('pin_test_unknown')).rejects.toMatchObject({
      tokenInvalid: true,
    });
    await expect(pin.getUserDetails('pin_bad_x')).rejects.toMatchObject({ tokenInvalid: true });
  });

  it('pin_low_ keys fail sends and calls with provider_balance_low', async () => {
    const num = await seed(FAKE_PINNACLE_KEY_PREFIXES.balanceLow);
    const err: unknown = await pin
      .sendMessage(num.apiKey, num.phoneNumberId, { messaging_product: 'whatsapp' } as never)
      .catch((e: unknown) => e);
    expect(isProviderBalanceLow(err)).toBe(true);
    const callErr: unknown = await pin
      .startCall(num.apiKey, num.phoneNumberId, { to: '919000000001', sdpOffer: 'v=0' })
      .catch((e: unknown) => e);
    expect(isProviderBalanceLow(callErr)).toBe(true);
    // reads still work
    expect((await pin.getPhoneNumber(num.apiKey, num.phoneNumberId)).id).toBe(num.phoneNumberId);
  });

  it('webhook: set, read back, clear, ignore writes, overwrite', async () => {
    const num = await seed();
    await pin.setWebhook(num.apiKey, num.phoneNumberId, 'https://x.test/h', { a: '1' });
    expect(await pin.getWebhook(num.apiKey, num.phoneNumberId)).toEqual({
      url: 'https://x.test/h',
      headers: { a: '1' },
    });
    await pin.setWebhook(num.apiKey, num.phoneNumberId, '', {});
    expect(await pin.getWebhook(num.apiKey, num.phoneNumberId)).toBeNull();
    pin.ignoreWebhookWrites(true);
    await pin.setWebhook(num.apiKey, num.phoneNumberId, 'https://x.test/h', {});
    expect(await pin.getWebhook(num.apiKey, num.phoneNumberId)).toBeNull();
    pin.ignoreWebhookWrites(false);
    await pin.overwriteWebhook(num.phoneNumberId, { url: 'https://other.test', headers: {} });
    expect((await pin.getWebhook(num.apiKey, num.phoneNumberId))?.url).toBe('https://other.test');
  });

  it('failNext and unsupported methods', async () => {
    const num = await seed();
    pin.failNext('setWebhook');
    await expect(
      pin.setWebhook(num.apiKey, num.phoneNumberId, 'https://x.test/h', {}),
    ).rejects.toMatchObject({ type: 'provider_error' });
    expect(isProviderUnsupported(await pin.debugToken('x').catch((e: unknown) => e))).toBe(true);
  });

  it('createPinnacleFromEnv: null when off, the fake with the fake Meta', () => {
    expect(createPinnacleFromEnv(testEnv(), meta, { redis })).toBeNull();
    const on = createPinnacleFromEnv(testEnv({ PINNACLE_ENABLED: 'true' }), meta, { redis });
    expect(on?.provider).toBe('pinnacle');
    expect((on as FakePinnacleClient).fake).toBe(true);
  });
});
