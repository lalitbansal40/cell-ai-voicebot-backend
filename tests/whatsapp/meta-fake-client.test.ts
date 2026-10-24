import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFakeCode,
  createFakeMetaClient,
  FAKE_EXISTING_PIN,
  FAKE_SYSTEM_USER_ID,
  fakeIds,
  graphError,
  type FakeMetaClient,
  type FakeSignup,
} from '../../src/core/meta';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

let redis: Redis;
let fake: FakeMetaClient;
const prefix = uniquePrefix('fake-meta');

beforeAll(async () => {
  redis = (await requireRedis()).client;
  fake = createFakeMetaClient({ redis, prefix, appSecret: 'fake-secret' });
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

let n = 0;
const signup = (over: Partial<FakeSignup> = {}): FakeSignup => {
  n += 1;
  return {
    businessName: `Test Business ${String(n)}`,
    phone: `+91 90000 1${String(n).padStart(4, '0')}`,
    displayName: 'Test Business',
    mode: 'cloud_api',
    outcome: 'finish',
    ...over,
  };
};
const connect = async (over: Partial<FakeSignup> = {}) => {
  const s = signup(over);
  const { accessToken } = await fake.exchangeCode(buildFakeCode(s));
  return { s, token: accessToken, ids: fakeIds(s.businessName, s.phone) };
};

describe('fake Meta — signup codes and tokens', () => {
  it('codes are single use; bad / error / cancel codes fail like Meta', async () => {
    const code = buildFakeCode(signup());
    const { accessToken, tokenType } = await fake.exchangeCode(code);
    expect(accessToken).toMatch(/^fake_tok_[0-9a-f]{12}_[0-9a-f]{16}$/);
    expect(tokenType).toBe('bearer');
    await expect(fake.exchangeCode(code)).rejects.toMatchObject({ code: 100, subcode: 36009 });
    await expect(fake.exchangeCode('real-meta-code')).rejects.toMatchObject({ subcode: 36007 });
    await expect(fake.exchangeCode('fake.!!!')).rejects.toMatchObject({ subcode: 36007 });
    await expect(
      fake.exchangeCode(`fake.${Buffer.from('{"x":1}').toString('base64url')}`),
    ).rejects.toMatchObject({ subcode: 36007 });
    await expect(
      fake.exchangeCode(buildFakeCode(signup({ outcome: 'error' }))),
    ).rejects.toMatchObject({
      subcode: 36007,
    });
    await expect(
      fake.exchangeCode(buildFakeCode(signup({ outcome: 'cancel' }))),
    ).rejects.toMatchObject({
      subcode: 36007,
    });
  });

  it('ids are deterministic (same business + phone → same WABA / number)', () => {
    const a = fakeIds('Test Co', '+91 90000 00010');
    expect(fakeIds(' Test Co ', '919000000010')).toEqual(a);
    expect(a.wabaId).toMatch(/^fake_waba_[0-9a-f]{12}$/);
    expect(a.phoneNumberId).toBe(`fake_phone_${a.h}`);
    expect(fakeIds('Other Co', '+91 90000 00010').h).not.toBe(a.h);
  });

  it('debug token: scopes + granted WABA; revoked / unknown → invalid and 190 everywhere', async () => {
    const { token, ids } = await connect();
    expect(await fake.debugToken(token)).toMatchObject({
      isValid: true,
      userId: ids.userId,
      expiresAt: null,
      grantedWabaIds: [ids.wabaId],
      scopes: expect.arrayContaining([
        'whatsapp_business_management',
        'whatsapp_business_messaging',
      ]) as string[],
    });
    await fake.revokeToken(token);
    expect(await fake.debugToken(token)).toMatchObject({
      isValid: false,
      grantedWabaIds: [],
      userId: null,
    });
    await expect(fake.getWaba(token, ids.wabaId)).rejects.toMatchObject({
      code: 190,
      tokenInvalid: true,
    });
    expect((await fake.debugToken('garbage')).isValid).toBe(false);
    await expect(
      fake.listOwnedWabas('fake_tok_000000000000_0000000000000000'),
    ).rejects.toMatchObject({
      tokenInvalid: true,
    });
  });
});

describe('fake Meta — WABA and phone', () => {
  it('lists and details', async () => {
    const { s, token, ids } = await connect();
    expect(await fake.listOwnedWabas(token)).toEqual([{ id: ids.wabaId, name: s.businessName }]);
    expect(await fake.listBusinessesWithWabas(token)).toEqual([
      {
        id: ids.businessId,
        name: s.businessName,
        wabas: [{ id: ids.wabaId, name: s.businessName }],
      },
    ]);
    expect(await fake.getWaba(token, ids.wabaId)).toMatchObject({
      currency: 'INR',
      businessId: ids.businessId,
      primaryFundingId: null,
    });
    expect(await fake.listPhoneNumbers(token, ids.wabaId)).toEqual([
      {
        id: ids.phoneNumberId,
        displayPhoneNumber: s.phone,
        verifiedName: 'Test Business',
        status: 'PENDING',
      },
    ]);
    expect(await fake.getPhoneNumber(token, ids.phoneNumberId)).toMatchObject({
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_2K',
      nameStatus: 'APPROVED',
      status: 'PENDING',
      isOnBizApp: false,
      throughputLevel: 'STANDARD',
    });
  });

  it("another identity's WABA / phone → not found", async () => {
    const a = await connect();
    const b = await connect();
    await expect(fake.getWaba(a.token, b.ids.wabaId)).rejects.toMatchObject({ code: 100 });
    await expect(fake.getPhoneNumber(a.token, b.ids.phoneNumberId)).rejects.toMatchObject({
      code: 100,
    });
    await expect(fake.getWaba(a.token, 'not-a-fake-id')).rejects.toMatchObject({ code: 100 });
  });

  it('pending names, foreign currency, coexistence numbers', async () => {
    const pending = await connect({ displayName: 'Pending Name Co' });
    expect((await fake.getPhoneNumber(pending.token, pending.ids.phoneNumberId)).nameStatus).toBe(
      'PENDING_REVIEW',
    );
    const foreign = await connect({ businessName: 'Foreign Traders' });
    expect((await fake.getWaba(foreign.token, foreign.ids.wabaId)).currency).toBe('XYZ');
    const coex = await connect({ mode: 'coexistence' });
    expect(await fake.getPhoneNumber(coex.token, coex.ids.phoneNumberId)).toMatchObject({
      isOnBizApp: true,
      status: 'CONNECTED',
    });
  });

  it('only_waba: no number until one is added', async () => {
    const { token, ids } = await connect({ outcome: 'only_waba' });
    expect(await fake.listPhoneNumbers(token, ids.wabaId)).toEqual([]);
    await expect(fake.getPhoneNumber(token, ids.phoneNumberId)).rejects.toMatchObject({
      code: 100,
    });
    await fake.addPhoneNumber(ids.wabaId);
    await fake.addPhoneNumber('not-a-waba');
    expect(await fake.listPhoneNumbers(token, ids.wabaId)).toHaveLength(1);
  });

  it('patchPhone overrides details (simulator / health)', async () => {
    const { token, ids } = await connect();
    await fake.patchPhone(ids.phoneNumberId, {
      quality_rating: 'RED',
      messaging_limit_tier: 'TIER_250',
    });
    await fake.patchPhone(ids.phoneNumberId, {});
    expect(await fake.getPhoneNumber(token, ids.phoneNumberId)).toMatchObject({
      qualityRating: 'RED',
      messagingLimitTier: 'TIER_250',
    });
  });
});

describe('fake Meta — setup steps and knobs', () => {
  it('subscribe / unsubscribe; …00002 → retryable 500', async () => {
    const { token, ids } = await connect();
    await fake.subscribeApp(token, ids.wabaId);
    expect(await fake.isSubscribed(ids.wabaId)).toBe(true);
    await fake.unsubscribeApp(token, ids.wabaId);
    expect(await fake.isSubscribed(ids.wabaId)).toBe(false);
    const failing = await connect({ phone: '+91 90000 00002', businessName: 'Sub Fail Co' });
    await expect(fake.subscribeApp(failing.token, failing.ids.wabaId)).rejects.toMatchObject({
      status: 500,
      retryable: true,
    });
  });

  it('register: 6 digits; …00001 needs the existing PIN (133005 otherwise)', async () => {
    const { token, ids } = await connect();
    await expect(fake.registerPhone(token, ids.phoneNumberId, '12')).rejects.toMatchObject({
      code: 100,
    });
    await fake.registerPhone(token, ids.phoneNumberId, '654321');
    expect(await fake.isRegistered(ids.phoneNumberId)).toBe(true);
    expect((await fake.getPhoneNumber(token, ids.phoneNumberId)).status).toBe('CONNECTED');
    const pin = await connect({ phone: '+91 90000 00001', businessName: 'Pin Co' });
    await expect(
      fake.registerPhone(pin.token, pin.ids.phoneNumberId, '654321'),
    ).rejects.toMatchObject({
      code: 133005,
    });
    expect(await fake.isRegistered(pin.ids.phoneNumberId)).toBe(false);
    await fake.registerPhone(pin.token, pin.ids.phoneNumberId, FAKE_EXISTING_PIN);
    expect(await fake.isRegistered(pin.ids.phoneNumberId)).toBe(true);
  });

  it('billing: system user, credit line (currency / other partner), allocation, payment method', async () => {
    const { token, ids } = await connect();
    expect(await fake.getTokenOwner('any-system-token')).toBe(FAKE_SYSTEM_USER_ID);
    await expect(fake.getTokenOwner('')).rejects.toMatchObject({ tokenInvalid: true });
    await fake.assignSystemUser(token, ids.wabaId, FAKE_SYSTEM_USER_ID);
    await expect(fake.assignSystemUser(token, ids.wabaId, 'someone')).rejects.toMatchObject({
      code: 100,
    });
    expect(await fake.attachCreditLine(ids.wabaId, 'INR')).toEqual({
      allocationConfigId: ids.allocationConfigId,
    });
    expect((await fake.getWaba(token, ids.wabaId)).primaryFundingId).toBe(`fake_funding_${ids.h}`);
    expect(await fake.getAllocation(ids.allocationConfigId)).toEqual({
      id: ids.allocationConfigId,
      receivingCredentialId: `fake_cred_${ids.h}`,
    });
    await expect(fake.getAllocation('nope')).rejects.toMatchObject({ code: 100 });
    await expect(fake.attachCreditLine(ids.wabaId, 'XYZ')).rejects.toMatchObject({ code: 100 });
    await expect(fake.attachCreditLine('fake_waba_ffffffffffff', 'INR')).rejects.toMatchObject({
      code: 100,
    });
    await expect(fake.attachCreditLine('nope', 'INR')).rejects.toMatchObject({ code: 100 });
    const other = await connect({ businessName: 'Other Partner Clients' });
    await expect(fake.attachCreditLine(other.ids.wabaId, 'INR')).rejects.toThrow(/another partner/);
    const customer = await connect();
    await fake.addPaymentMethod(customer.ids.wabaId);
    expect(
      (await fake.getWaba(customer.token, customer.ids.wabaId)).primaryFundingId,
    ).not.toBeNull();
  });

  it('coexistence sync only for Business app numbers', async () => {
    const coex = await connect({ mode: 'coexistence' });
    expect(
      await fake.requestCoexistenceSync(coex.token, coex.ids.phoneNumberId, 'history'),
    ).toEqual({
      requestId: `fake_sync_${coex.ids.h}_history`,
    });
    const cloud = await connect();
    await expect(
      fake.requestCoexistenceSync(cloud.token, cloud.ids.phoneNumberId, 'smb_app_state_sync'),
    ).rejects.toMatchObject({ code: 100 });
  });

  it('failNext queues failures per op; calls are recorded', async () => {
    const { token, ids } = await connect();
    fake.calls.length = 0;
    fake.failNext('getWaba');
    fake.failNext('getWaba', graphError(400, { error: { code: 100, message: 'custom' } }));
    await expect(fake.getWaba(token, ids.wabaId)).rejects.toMatchObject({
      status: 500,
      retryable: true,
    });
    await expect(fake.getWaba(token, ids.wabaId)).rejects.toThrow('custom');
    expect((await fake.getWaba(token, ids.wabaId)).id).toBe(ids.wabaId);
    expect(fake.calls).toEqual([
      { op: 'getWaba', target: ids.wabaId },
      { op: 'getWaba', target: ids.wabaId },
      { op: 'getWaba', target: ids.wabaId },
    ]);
    expect(fake.provider).toBe('fake');
    expect(fake.appSecret).toBe('fake-secret');
  });

  it('without a prefix the keys are unprefixed', async () => {
    const plain = createFakeMetaClient({ redis, appSecret: 's' });
    expect(await plain.isSubscribed(`fake_waba_${prefix.replace(/\W/g, '')}`)).toBe(false);
  });
});
