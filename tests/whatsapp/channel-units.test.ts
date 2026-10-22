import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { graphError, MetaApiError, type MetaClient } from '../../src/core/meta';
import type { WhatsAppChannelDoc } from '../../src/db/models/whatsapp-channel.model';
import { creditLineIdOf, setupBilling } from '../../src/modules/whatsapp/billing-setup';
import {
  channelDetail,
  channelEvent,
  channelListItem,
} from '../../src/modules/whatsapp/channel-json';
import { numberName } from '../../src/modules/whatsapp/channel-status';
import {
  canRetryCoexistence,
  requestCoexistenceSyncs,
} from '../../src/modules/whatsapp/coexistence';
import { phoneLast4, toE164, type WhatsAppContext } from '../../src/modules/whatsapp/context';
import { signupError } from '../../src/modules/whatsapp/errors';
import {
  EmbeddedSignupBody,
  RegisterPinBody,
  RenameChannelBody,
} from '../../src/modules/whatsapp/whatsapp.schema';
import { testEnv } from '../helpers/test-app';

const now = new Date('2026-10-22T10:00:00Z');
const channel = (over: Partial<WhatsAppChannelDoc> = {}): WhatsAppChannelDoc =>
  ({
    _id: new Types.ObjectId(),
    accountId: new Types.ObjectId(),
    label: 'Support',
    provider: 'fake',
    mode: 'cloud_api',
    wabaId: 'fake_waba_aaaaaaaaaaaa',
    phoneNumberId: 'fake_phone_aaaaaaaaaaaa',
    displayPhoneNumber: null,
    metaPayer: 'platform',
    status: 'connected',
    statusReason: null,
    creditLine: { status: 'not_needed', allocationConfigId: null, error: null, at: null },
    coexistence: {
      contactsSync: 'not_requested',
      historySync: 'not_requested',
      historyProgress: null,
      echoesAt: null,
    },
    registration: { status: 'not_needed', error: null, at: null },
    subscription: { status: null, error: null, at: null },
    restriction: null,
    webhook: { lastEventAt: null, lastField: null },
    history: [],
    connectedBy: null,
    disconnectedBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }) as unknown as WhatsAppChannelDoc;

const waba = {
  id: 'w',
  name: null,
  currency: 'INR',
  timezoneId: null,
  templateNamespace: null,
  reviewStatus: null,
  businessVerificationStatus: null,
  businessId: null,
  businessName: null,
  primaryFundingId: null,
};

const ctxWith = (meta: Partial<MetaClient>, env: NodeJS.ProcessEnv = {}): WhatsAppContext =>
  ({
    env: testEnv(env),
    meta: { provider: 'meta', ...meta },
    now: () => now,
  }) as unknown as WhatsAppContext;

describe('billing setup (Graph provider)', () => {
  const env = { META_CREDIT_LINE_ID: '123', META_SYSTEM_USER_TOKEN: 'sys' };

  it('attaches with the System User; skips an attached line; null currency refused', async () => {
    const seen: string[] = [];
    const meta: Partial<MetaClient> = {
      getTokenOwner: (t) => (seen.push(`owner:${t}`), Promise.resolve('u1')),
      assignSystemUser: () => Promise.resolve(),
      attachCreditLine: () => Promise.resolve({ allocationConfigId: 'a1' }),
      getAllocation: () => Promise.resolve({ id: 'a1', receivingCredentialId: null }),
    };
    const r = await setupBilling(ctxWith(meta, env), channel(), 'tok', waba);
    expect(r).toMatchObject({
      attached: true,
      patch: { creditLine: { status: 'attached', allocationConfigId: 'a1', at: now } },
    });
    expect(seen).toEqual(['owner:sys']);
    expect(
      await setupBilling(
        ctxWith(meta, env),
        channel({
          creditLine: { status: 'attached', allocationConfigId: 'a', error: null, at: now },
        }),
        'tok',
        waba,
      ),
    ).toEqual({ patch: {}, attached: false });
    const r2 = await setupBilling(ctxWith(meta, env), channel(), 'tok', {
      ...waba,
      currency: null,
    });
    expect(r2.fail?.message).toContain('(unknown)');
    expect(creditLineIdOf(ctxWith({}, env))).toBe('123');
    expect(creditLineIdOf(ctxWith({}))).toBeNull();
    expect(creditLineIdOf({ meta: { provider: 'fake' } } as WhatsAppContext)).toBe('fake_ecl_1');
  });

  it('missing config, token errors rethrown, a failed allocation check logs only', async () => {
    expect(
      (await setupBilling(ctxWith({}, { META_CREDIT_LINE_ID: '1' }), channel(), 't', waba)).fail
        ?.code,
    ).toBe('credit_line_not_configured');
    const tokenErr = graphError(401, { error: { code: 190 } });
    await expect(
      setupBilling(
        ctxWith({ getTokenOwner: () => Promise.reject(tokenErr) }, env),
        channel(),
        't',
        waba,
      ),
    ).rejects.toBe(tokenErr);
    await expect(
      setupBilling(
        ctxWith({ getTokenOwner: () => Promise.reject(new Error('x')) }, env),
        channel(),
        't',
        waba,
      ),
    ).rejects.toThrow('x');
    const r = await setupBilling(
      ctxWith(
        {
          getTokenOwner: () => Promise.resolve('u'),
          assignSystemUser: () => Promise.resolve(),
          attachCreditLine: () => Promise.resolve({ allocationConfigId: 'a' }),
          getAllocation: () => Promise.reject(new Error('plain')),
        },
        env,
      ),
      channel(),
      't',
      waba,
    );
    expect(r.attached).toBe(true);
  });
});

describe('coexistence helpers', () => {
  it('skips cloud numbers / missing numbers; rethrows non-Meta errors', async () => {
    const coex = channel({ mode: 'coexistence' });
    expect(await requestCoexistenceSyncs({ meta: {} as MetaClient }, channel(), 't')).toEqual(
      channel().coexistence,
    );
    expect(
      await requestCoexistenceSyncs(
        { meta: {} as MetaClient },
        { ...coex, phoneNumberId: null },
        't',
      ),
    ).toEqual(coex.coexistence);
    await expect(
      requestCoexistenceSyncs(
        {
          meta: {
            requestCoexistenceSync: () => Promise.reject(new Error('b')),
          } as unknown as MetaClient,
        },
        coex,
        't',
      ),
    ).rejects.toThrow('b');
    expect(canRetryCoexistence(channel())).toBe(false);
    expect(
      canRetryCoexistence({
        ...coex,
        coexistence: { ...coex.coexistence, contactsSync: 'received', historySync: 'received' },
      }),
    ).toBe(false);
    expect(
      canRetryCoexistence({
        ...coex,
        coexistence: { ...coex.coexistence, contactsSync: 'received' },
      }),
    ).toBe(true);
  });
});

describe('views and helpers', () => {
  it('list / detail / event views', () => {
    const c = channel({
      mode: 'coexistence',
      statusReason: { code: 'x', message: 'y' },
      restriction: { type: 'R', until: now },
      connectedBy: new Types.ObjectId(),
      history: [{ status: 'connected', reason: null, at: now, by: null }],
    });
    const item = channelListItem(c);
    expect(item).toMatchObject({
      statusReason: { code: 'x', message: 'y', step: null },
      restriction: { type: 'R', until: now.toISOString() },
      coexistence: { echoesAt: null },
    });
    expect(channelDetail(c, { total: 0, byField: {} }).history).toEqual([
      { status: 'connected', reason: null, at: now.toISOString(), by: null },
    ]);
    expect(channelEvent(c)).toEqual({
      channelId: c._id.toString(),
      status: 'connected',
      qualityRating: undefined,
      messagingLimitTier: undefined,
      nameStatus: undefined,
    });
    expect(channelListItem(channel()).restriction).toBeNull();
  });

  it('numbers and names', () => {
    expect(toE164('+91 90000 00010')).toBe('+919000000010');
    expect(toE164('123')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(phoneLast4(undefined)).toBe('');
    expect(numberName(channel())).toBe('"Support"');
    expect(numberName(channel({ displayPhoneNumber: '+91 90000 01234' }))).toBe(
      '"Support" (…1234)',
    );
  });

  it('signup errors pass non-Meta errors through', () => {
    const plain = new Error('x');
    expect(signupError(plain, 'exchange')).toBe(plain);
    const meta = new MetaApiError({
      status: 400,
      code: 1,
      subcode: null,
      type: 'GraphMethodException',
      message: 'm',
      fbtraceId: null,
      retryable: true,
      tokenInvalid: false,
    });
    expect(signupError(meta, 'exchange')).toMatchObject({
      code: 'META_API_ERROR',
      details: [{ path: 'meta' }],
    });
  });

  it('request schemas', () => {
    expect(
      EmbeddedSignupBody.safeParse({ code: 'c', mode: 'cloud_api', sessionInfo: { wabaId: '123' } })
        .success,
    ).toBe(true);
    expect(
      EmbeddedSignupBody.safeParse({
        code: 'c',
        mode: 'cloud_api',
        sessionInfo: { wabaId: 'fake_waba_aaaaaaaaaaaa' },
      }).success,
    ).toBe(true);
    expect(
      EmbeddedSignupBody.safeParse({
        code: 'c',
        mode: 'cloud_api',
        sessionInfo: { wabaId: '1;drop' },
      }).success,
    ).toBe(false);
    expect(EmbeddedSignupBody.safeParse({ code: '', mode: 'cloud_api' }).success).toBe(false);
    expect(EmbeddedSignupBody.safeParse({ code: 'c', mode: 'x' }).success).toBe(false);
    expect(RenameChannelBody.parse({ label: '  Sales  ' }).label).toBe('Sales');
    expect(RenameChannelBody.safeParse({ label: 'x'.repeat(61) }).success).toBe(false);
    expect(RegisterPinBody.safeParse({ pin: '12345' }).success).toBe(false);
    expect(RegisterPinBody.safeParse({ pin: '123456' }).success).toBe(true);
  });
});
