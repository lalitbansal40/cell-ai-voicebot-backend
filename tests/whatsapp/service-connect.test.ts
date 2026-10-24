import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { open } from '../../src/core/ai/secret-box';
import { FAKE_EXISTING_PIN, graphError, type MetaClient } from '../../src/core/meta';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { createWhatsAppService } from '../../src/modules/whatsapp/whatsapp.service';
import type { AppError } from '../../src/shared/errors/app-error';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import {
  codeFor,
  fakeSignup,
  idsFor,
  insertChannel,
  userActor,
  useWhatsAppWorld,
} from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();

let acc: TestAccount;
let ownerId: Types.ObjectId;
beforeEach(async () => {
  acc = await createTestAccount();
  ownerId = (await acc.addUser('owner')).user._id;
});

const connect = (signup = fakeSignup(), over: Record<string, unknown> = {}, svc = w.svc) =>
  svc.connect({
    accountId: acc.account._id,
    actor: userActor(ownerId),
    mode: signup.mode,
    code: codeFor(signup),
    sessionInfo: { wabaId: idsFor(signup).wabaId, phoneNumberId: idsFor(signup).phoneNumberId },
    ...over,
  });

const withSecrets = (id: string) =>
  WhatsAppChannelModel.findById(id)
    .select('+tokenSealed +registration.pinSealed')
    .lean<WhatsAppChannelDoc>();
const actions = async (channelId: string) =>
  (await AuditLogModel.find({ 'target.id': channelId }).sort({ at: 1 }).lean()).map(
    (a) => a.action,
  );
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as AppError,
  );
/** A Meta client with some methods replaced. */
const metaWith = (over: Partial<MetaClient>): MetaClient => ({ ...w.fake, ...over });

describe('connect — happy paths', () => {
  it('Cloud API, platform credit line: subscribed, attached, registered; secrets sealed', async () => {
    const signup = fakeSignup();
    const ids = idsFor(signup);
    const result = await connect(signup);
    expect(result.outcome).toBe('connected');
    expect(result.reconnected).toBe(false);
    expect(result.channel).toMatchObject({
      status: 'connected',
      mode: 'cloud_api',
      provider: 'fake',
      wabaId: ids.wabaId,
      phoneNumberId: ids.phoneNumberId,
      displayPhoneNumber: signup.phone,
      phoneE164: `+${signup.phone.replace(/\D/g, '')}`,
      label: 'Test Business',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_2K',
      nameStatus: 'APPROVED',
      billing: { metaPayer: 'platform', creditLine: { status: 'attached' }, paymentMethodOk: null },
      registration: { status: 'registered' },
      subscription: { status: 'subscribed' },
      coexistence: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/tokenSealed|pinSealed|fake_tok_/);
    const stored = await withSecrets(result.channel.id);
    expect(stored?.tokenSealed).toMatch(/^v1:/);
    const token = open(w.ctx.key, stored?.tokenSealed ?? '');
    expect(token).toMatch(/^fake_tok_/);
    expect(open(w.ctx.key, stored?.registration.pinSealed ?? '')).toMatch(/^\d{6}$/);
    expect(stored).toMatchObject({
      metaUserId: ids.userId,
      businessId: ids.businessId,
      wabaCurrency: 'INR',
      creditLine: { status: 'attached', allocationConfigId: ids.allocationConfigId },
      connectedBy: ownerId,
      tokenScopes: expect.arrayContaining(['whatsapp_business_management']) as string[],
    });
    expect(stored?.history.map((h) => h.status)).toEqual(['connecting', 'connected']);
    expect(await w.fake.isSubscribed(ids.wabaId)).toBe(true);
    expect(await w.fake.isRegistered(ids.phoneNumberId)).toBe(true);
    expect(await actions(result.channel.id)).toEqual([
      'whatsapp.channel_connected',
      'whatsapp.credit_line_attached',
      'whatsapp.channel_registered',
    ]);
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.channel_connected',
      'target.id': result.channel.id,
    }).lean();
    expect(audit?.meta).toMatchObject({
      mode: 'cloud_api',
      phoneLast4: signup.phone.replace(/\D/g, '').slice(-4),
      wabaId: ids.wabaId,
    });
    expect(JSON.stringify(audit)).not.toContain(signup.phone.replace(/\D/g, ''));
  });

  it('coexistence: no registration, contacts + history sync requested', async () => {
    const signup = fakeSignup({ mode: 'coexistence' });
    w.fake.calls.length = 0;
    const result = await connect(signup);
    expect(result.channel).toMatchObject({
      status: 'connected',
      mode: 'coexistence',
      isOnBizApp: true,
      registration: { status: 'not_needed' },
      coexistence: { contactsSync: 'requested', historySync: 'requested', historyProgress: 0 },
    });
    const ops = w.fake.calls.map((c) => c.op);
    expect(ops.filter((o) => o === 'requestCoexistenceSync')).toHaveLength(2);
    expect(ops).not.toContain('registerPhone');
  });

  it('a Cloud API choice on a Business app number follows Meta (coexistence)', async () => {
    const signup = fakeSignup({ mode: 'coexistence' });
    const result = await connect(signup, { mode: 'cloud_api' });
    expect(result.channel.mode).toBe('coexistence');
  });

  it('already registered numbers are not registered again', async () => {
    const signup = fakeSignup();
    const ids = idsFor(signup);
    await connect(signup);
    await w.fake.patchPhone(ids.phoneNumberId, { status: 'CONNECTED' });
    w.fake.calls.length = 0;
    const again = await connect({ ...signup });
    expect(again.channel.registration.status).toBe('registered');
    expect(w.fake.calls.map((c) => c.op)).not.toContain('registerPhone');
    // a number registered by someone else (status CONNECTED, never by us) → not_needed
    const other = fakeSignup();
    const otherIds = idsFor(other);
    await w.fake.exchangeCode(codeFor({ ...other, outcome: 'finish' })).catch(() => null);
    await w.fake.patchPhone(otherIds.phoneNumberId, { status: 'CONNECTED' });
    const result = await connect({ ...other, businessName: other.businessName });
    expect(result.channel.registration.status).toBe('not_needed');
  });
});

describe('connect — WABA / number resolution', () => {
  it('without session info the single granted WABA / number is used', async () => {
    const signup = fakeSignup();
    const result = await connect(signup, { sessionInfo: undefined });
    expect(result.channel.phoneNumberId).toBe(idsFor(signup).phoneNumberId);
  });

  it('no granted ids → discovery via owned WABAs, then businesses', async () => {
    const noGrants = (svcMeta: Partial<MetaClient>) =>
      createWhatsAppService({
        ...w.ctx,
        meta: metaWith({
          debugToken: async (t) => ({ ...(await w.fake.debugToken(t)), grantedWabaIds: [] }),
          ...svcMeta,
        }),
      });
    const a = fakeSignup();
    expect((await connect(a, { sessionInfo: undefined }, noGrants({}))).outcome).toBe('connected');
    const b = fakeSignup();
    w.fake.calls.length = 0;
    const viaBusinesses = noGrants({ listOwnedWabas: () => Promise.resolve([]) });
    expect((await connect(b, { sessionInfo: undefined }, viaBusinesses)).outcome).toBe('connected');
    expect(w.fake.calls.map((c) => c.op)).toContain('listBusinessesWithWabas');
    // a hint is accepted when discovery finds it
    const c = fakeSignup();
    expect(
      (await connect(c, { sessionInfo: { wabaId: idsFor(c).wabaId } }, noGrants({}))).outcome,
    ).toBe('connected');
    // nothing found / several found
    const none = noGrants({
      listOwnedWabas: () => Promise.resolve([]),
      listBusinessesWithWabas: () => Promise.resolve([]),
    });
    expect(await failure(connect(fakeSignup(), { sessionInfo: undefined }, none))).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      message: 'No WhatsApp Business Account was shared.',
      details: [{ path: 'step', message: 'waba' }],
    });
    const several = noGrants({
      listOwnedWabas: () =>
        Promise.resolve([
          { id: '1', name: null },
          { id: '2', name: null },
        ]),
    });
    expect(
      (await failure(connect(fakeSignup(), { sessionInfo: undefined }, several)))?.message,
    ).toMatch(/Several/);
  });

  it('a session WABA that was not granted is refused; so is a foreign phone id', async () => {
    const signup = fakeSignup();
    expect(await failure(connect(signup, { sessionInfo: { wabaId: '999999' } }))).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      details: [{ path: 'step', message: 'waba' }],
    });
    expect(
      await failure(connect(fakeSignup(), { sessionInfo: { phoneNumberId: '12345' } })),
    ).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      details: [{ path: 'step', message: 'phone' }],
    });
    expect(await WhatsAppChannelModel.countDocuments({ accountId: acc.account._id })).toBe(0);
  });

  it('several numbers without a hint → refused', async () => {
    const svc = createWhatsAppService({
      ...w.ctx,
      meta: metaWith({
        listPhoneNumbers: () =>
          Promise.resolve([
            { id: '1', displayPhoneNumber: null, verifiedName: null, status: null },
            { id: '2', displayPhoneNumber: null, verifiedName: null, status: null },
          ]),
      }),
    });
    expect(
      (await failure(connect(fakeSignup(), { sessionInfo: undefined }, svc)))?.message,
    ).toMatch(/several numbers/);
  });

  it('missing scopes / invalid token → refused at verify', async () => {
    const noScopes = createWhatsAppService({
      ...w.ctx,
      meta: metaWith({
        debugToken: async (t) => ({
          ...(await w.fake.debugToken(t)),
          scopes: ['business_management'],
        }),
      }),
    });
    expect(await failure(connect(fakeSignup(), {}, noScopes))).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      details: [{ path: 'step', message: 'verify' }],
    });
    const invalid = createWhatsAppService({
      ...w.ctx,
      meta: metaWith({
        debugToken: async (t) => ({ ...(await w.fake.debugToken(t)), isValid: false }),
      }),
    });
    expect((await failure(connect(fakeSignup(), {}, invalid)))?.code).toBe(
      'WHATSAPP_SIGNUP_FAILED',
    );
    const token190 = createWhatsAppService({
      ...w.ctx,
      meta: metaWith({
        debugToken: () => Promise.reject(graphError(401, { error: { code: 190 } })),
      }),
    });
    expect((await failure(connect(fakeSignup(), {}, token190)))?.code).toBe(
      'WHATSAPP_SIGNUP_FAILED',
    );
    const down = createWhatsAppService({
      ...w.ctx,
      meta: metaWith({
        debugToken: () => Promise.reject(graphError(500, { error: { code: 2, fbtrace_id: 'tr' } })),
      }),
    });
    expect(await failure(connect(fakeSignup(), {}, down))).toMatchObject({
      code: 'META_API_ERROR',
      details: [{ path: 'meta', metaCode: 2, fbtraceId: 'tr' }],
    });
  });

  it('signup codes: used / expired / Meta down', async () => {
    const signup = fakeSignup();
    const code = codeFor(signup);
    await connect(signup, { code });
    expect(await failure(connect(signup, { code }))).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      message: 'This Meta signup was already used — connect again.',
      details: [{ path: 'step', message: 'exchange' }],
    });
    expect((await failure(connect(fakeSignup({ outcome: 'error' }))))?.message).toBe(
      'The Meta signup expired — try again.',
    );
    w.fake.failNext(
      'exchangeCode',
      graphError(503, { error: { code: 1, type: 'GraphMethodException' } }),
    );
    expect((await failure(connect(fakeSignup())))?.code).toBe('META_API_ERROR');
    w.fake.failNext(
      'listPhoneNumbers',
      graphError(500, { error: { code: 2, type: 'GraphMethodException' } }),
    );
    expect((await failure(connect(fakeSignup())))?.code).toBe('META_API_ERROR');
    w.fake.failNext('exchangeCode', new Error('boom') as never);
    await expect(connect(fakeSignup())).rejects.toThrow('boom');
  });

  it('only_waba → action needed; the number added later → sync connects it', async () => {
    const signup = fakeSignup({ outcome: 'only_waba' });
    const ids = idsFor(signup);
    const result = await connect(signup, { sessionInfo: { wabaId: ids.wabaId } });
    expect(result.outcome).toBe('action_needed');
    expect(result.channel).toMatchObject({
      phoneNumberId: null,
      statusReason: { code: 'no_phone_number', step: 'phone' },
    });
    // a second only-WABA signup of the same WABA reuses the row
    const again = await connect({ ...signup }, { sessionInfo: { wabaId: ids.wabaId } });
    expect(again.channel.id).toBe(result.channel.id);
    await w.fake.addPhoneNumber(ids.wabaId);
    const synced = await w.svc.sync(acc.account._id, result.channel.id, userActor(ownerId));
    expect(synced.outcome).toBe('connected');
    expect(synced.channel).toMatchObject({
      phoneNumberId: ids.phoneNumberId,
      displayPhoneNumber: signup.phone,
    });
  });

  it('a WABA with several numbers on retry asks to pick one; a number taken meanwhile → in use', async () => {
    const signup = fakeSignup({ outcome: 'only_waba' });
    const ids = idsFor(signup);
    const result = await connect(signup, { sessionInfo: { wabaId: ids.wabaId } });
    const several = createWhatsAppService({
      ...w.ctx,
      meta: metaWith({
        listPhoneNumbers: () =>
          Promise.resolve([
            { id: '1', displayPhoneNumber: null, verifiedName: null, status: null },
            { id: '2', displayPhoneNumber: null, verifiedName: null, status: null },
          ]),
      }),
    });
    const picked = await several.retrySetup(acc.account._id, result.channel.id, userActor(ownerId));
    expect(picked.channel.statusReason?.code).toBe('pick_number');
    await w.fake.addPhoneNumber(ids.wabaId);
    await insertChannel({ phoneNumberId: ids.phoneNumberId });
    const taken = await w.svc.retrySetup(acc.account._id, result.channel.id, userActor(ownerId));
    expect(taken.channel).toMatchObject({
      phoneNumberId: null,
      statusReason: { code: 'number_in_use' },
    });
  });
});

describe('connect — conflicts and limits', () => {
  it('a number active in another account → 409, nothing saved, token dropped', async () => {
    const signup = fakeSignup();
    await connect(signup);
    const other = await createTestAccount();
    const otherOwner = (await other.addUser('owner')).user._id;
    const err = await failure(
      w.svc.connect({
        accountId: other.account._id,
        actor: userActor(otherOwner),
        mode: 'cloud_api',
        code: codeFor({ ...signup }),
      }),
    );
    expect(err?.code).toBe('WHATSAPP_NUMBER_IN_USE');
    expect(await WhatsAppChannelModel.countDocuments({ accountId: other.account._id })).toBe(0);
  });

  it('reconnect in the same account keeps the id and the history (also after a disconnect)', async () => {
    const signup = fakeSignup();
    const first = await connect(signup);
    const second = await connect({ ...signup });
    expect(second).toMatchObject({ reconnected: true, outcome: 'connected' });
    expect(second.channel.id).toBe(first.channel.id);
    await w.svc.disconnect(acc.account._id, first.channel.id, userActor(ownerId));
    const third = await connect({ ...signup });
    expect(third.channel.id).toBe(first.channel.id);
    expect(third.reconnected).toBe(true);
    const stored = await withSecrets(first.channel.id);
    expect(stored?.history.map((h) => h.status)).toEqual([
      'connecting',
      'connected',
      'connecting',
      'connected',
      'disconnected',
      'connecting',
      'connected',
    ]);
    expect(stored?.tokenSealed).toMatch(/^v1:/);
    expect(await actions(first.channel.id)).toContain('whatsapp.channel_reconnected');
  });

  it('parallel connects of one number → one channel', async () => {
    const signup = fakeSignup();
    const results = await Promise.allSettled([connect({ ...signup }), connect({ ...signup })]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected')
        expect((r.reason as AppError).code).toBe('CONFLICT_INVALID_STATE');
    }
    expect(
      await WhatsAppChannelModel.countDocuments({ phoneNumberId: idsFor(signup).phoneNumberId }),
    ).toBe(1);
  });

  it('a create race lost to another account → in use; to the same account → conflict', async () => {
    const signup = fakeSignup();
    const ids = idsFor(signup);
    const count = WhatsAppChannelModel.countDocuments.bind(WhatsAppChannelModel);
    // the number appears between the duplicate check and the insert (the limit count runs in between)
    const raceWith = (holder: Types.ObjectId) =>
      vi
        .spyOn(WhatsAppChannelModel, 'countDocuments')
        .mockImplementationOnce(((...args: Parameters<typeof count>) =>
          insertChannel({ accountId: holder, phoneNumberId: ids.phoneNumberId }).then(() =>
            count(...args),
          )) as unknown as typeof count);
    raceWith(new Types.ObjectId());
    expect((await failure(connect({ ...signup })))?.code).toBe('WHATSAPP_NUMBER_IN_USE');
    await WhatsAppChannelModel.deleteMany({ phoneNumberId: ids.phoneNumberId });
    raceWith(acc.account._id);
    expect((await failure(connect({ ...signup })))?.code).toBe('CONFLICT_INVALID_STATE');
    vi.restoreAllMocks();
  });

  it('the account limit counts active numbers only', async () => {
    for (let i = 0; i < 9; i += 1) await insertChannel({ accountId: acc.account._id });
    await insertChannel({ accountId: acc.account._id, status: 'disconnected' });
    expect((await connect()).outcome).toBe('connected');
    expect((await failure(connect()))?.code).toBe('WHATSAPP_CHANNEL_LIMIT');
  });

  it('unknown account → 404', async () => {
    expect(
      (
        await failure(
          w.svc.connect({
            accountId: new Types.ObjectId(),
            actor: userActor(),
            mode: 'cloud_api',
            code: 'x',
          }),
        )
      )?.code,
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('connect — setup failures', () => {
  it('PIN already set → action needed → wrong PIN refused → right PIN connects', async () => {
    const signup = fakeSignup({
      phone: '+91 90000 00001',
      businessName: `Pin Co ${String(Date.now())}`,
    });
    const result = await connect(signup);
    expect(result.outcome).toBe('action_needed');
    expect(result.channel).toMatchObject({
      statusReason: { code: 'pin_required', step: 'register' },
      registration: { status: 'pending' },
    });
    const actor = userActor(ownerId);
    expect(
      await failure(w.svc.submitPin(acc.account._id, result.channel.id, '111111', actor)),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'pin' }],
    });
    const done = await w.svc.submitPin(
      acc.account._id,
      result.channel.id,
      FAKE_EXISTING_PIN,
      actor,
    );
    expect(done).toMatchObject({
      outcome: 'connected',
      channel: { registration: { status: 'registered' } },
    });
    const stored = await withSecrets(result.channel.id);
    expect(open(w.ctx.key, stored?.registration.pinSealed ?? '')).toBe(FAKE_EXISTING_PIN);
    expect(
      (await failure(w.svc.submitPin(acc.account._id, result.channel.id, '123456', actor)))?.code,
    ).toBe('CONFLICT_INVALID_STATE');
  });

  it('submitPin: Meta errors and lost tokens', async () => {
    const signup = fakeSignup({
      phone: '+91 90000 00001',
      businessName: `Pin Two ${String(Date.now())}`,
    });
    const result = await connect(signup);
    const actor = userActor(ownerId);
    w.fake.failNext(
      'registerPhone',
      graphError(500, { error: { code: 2, type: 'GraphMethodException' } }),
    );
    expect(
      (await failure(w.svc.submitPin(acc.account._id, result.channel.id, '123456', actor)))?.code,
    ).toBe('META_API_ERROR');
    w.fake.failNext('registerPhone', new Error('bug') as never);
    await expect(
      w.svc.submitPin(acc.account._id, result.channel.id, '123456', actor),
    ).rejects.toThrow('bug');
    w.fake.failNext('registerPhone', graphError(401, { error: { code: 190 } }));
    expect(
      (await failure(w.svc.submitPin(acc.account._id, result.channel.id, '123456', actor)))?.code,
    ).toBe('WHATSAPP_CHANNEL_NOT_READY');
    expect((await WhatsAppChannelModel.findById(result.channel.id).lean())?.status).toBe(
      'needs_reconnect',
    );
  });

  it('other register errors → action needed (register_failed)', async () => {
    w.fake.failNext(
      'registerPhone',
      graphError(400, { error: { code: 100, message: 'nope', type: 'GraphMethodException' } }),
    );
    const result = await connect();
    expect(result.channel).toMatchObject({
      statusReason: { code: 'register_failed', step: 'register' },
      registration: { status: 'failed' },
    });
  });

  it('subscribe fails → action needed → retry setup resumes at subscribe (finished steps skipped)', async () => {
    w.fake.failNext('subscribeApp');
    const result = await connect();
    expect(result.channel).toMatchObject({
      status: 'action_needed',
      statusReason: { code: 'subscribe_failed', step: 'subscribe' },
      subscription: { status: 'failed' },
    });
    const id = result.channel.id;
    expect(await actions(id)).toEqual([
      'whatsapp.channel_setup_failed',
      'whatsapp.channel_connected',
    ]);
    w.fake.calls.length = 0;
    const retried = await w.svc.retrySetup(acc.account._id, id, userActor(ownerId));
    expect(retried.outcome).toBe('connected');
    const ops = w.fake.calls.map((c) => c.op);
    expect(ops).toContain('subscribeApp');
    expect(ops).not.toContain('getPhoneNumber');
    expect(ops).not.toContain('exchangeCode');
    expect((await failure(w.svc.retrySetup(acc.account._id, id, userActor(ownerId))))?.code).toBe(
      'CONFLICT_INVALID_STATE',
    );
  });

  it('the subscribe knob (…00002) always fails', async () => {
    const signup = fakeSignup({
      phone: '+91 90000 00002',
      businessName: `Sub Co ${String(Date.now())}`,
    });
    expect((await connect(signup)).channel.statusReason?.code).toBe('subscribe_failed');
  });

  it('credit line: unsupported currency, other partner, not configured → action needed', async () => {
    const foreign = await connect(fakeSignup({ businessName: `Foreign ${String(Date.now())}` }));
    expect(foreign.channel).toMatchObject({
      statusReason: { code: 'unsupported_currency', step: 'billing' },
      billing: { creditLine: { status: 'failed' } },
    });
    const partner = await connect(
      fakeSignup({ businessName: `Other Partner ${String(Date.now())}` }),
    );
    expect(partner.channel.statusReason).toMatchObject({ code: 'credit_line_failed' });
    expect(partner.channel.statusReason?.message).toMatch(/another partner/);
    const metaMode = createWhatsAppService({ ...w.ctx, meta: { ...w.fake, provider: 'meta' } });
    const unconfigured = await connect(fakeSignup(), {}, metaMode);
    expect(unconfigured.channel.statusReason).toMatchObject({
      code: 'credit_line_not_configured',
      message: "Platform credit line isn't configured on this server.",
    });
    w.fake.failNext('getAllocation');
    expect((await connect()).outcome).toBe('connected'); // the allocation check is optional
  });

  it('the account switched to "customer pays Meta" → retry setup passes billing', async () => {
    const result = await connect(fakeSignup({ businessName: `Foreign Two ${String(Date.now())}` }));
    expect(result.outcome).toBe('action_needed');
    await AccountModel.updateOne(
      { _id: acc.account._id },
      { $set: { 'whatsapp.metaPayer': 'customer' } },
    );
    const retried = await w.svc.retrySetup(acc.account._id, result.channel.id, userActor(ownerId));
    expect(retried).toMatchObject({
      outcome: 'connected',
      channel: {
        billing: {
          metaPayer: 'customer',
          creditLine: { status: 'not_needed' },
          paymentMethodOk: false,
        },
      },
    });
  });

  it('customer pays Meta: payment method flag follows the WABA', async () => {
    await AccountModel.updateOne(
      { _id: acc.account._id },
      { $set: { 'whatsapp.metaPayer': 'customer' } },
    );
    const signup = fakeSignup();
    w.fake.calls.length = 0;
    const result = await connect(signup);
    expect(result.channel.billing).toEqual({
      metaPayer: 'customer',
      creditLine: { status: 'not_needed' },
      paymentMethodOk: false,
    });
    expect(w.fake.calls.map((c) => c.op)).not.toContain('attachCreditLine');
    await w.fake.addPaymentMethod(idsFor(signup).wabaId);
    const synced = await w.svc.sync(acc.account._id, result.channel.id, userActor(ownerId));
    expect(synced.channel.billing.paymentMethodOk).toBe(true);
  });

  it('a credit line failure that is a token error → needs reconnect', async () => {
    w.fake.failNext('assignSystemUser', graphError(401, { error: { code: 190 } }));
    const result = await connect();
    expect(result.outcome).toBe('needs_reconnect');
  });

  it('Graph 190 during setup → needs reconnect (+ fields gathered so far kept)', async () => {
    w.fake.failNext('subscribeApp', graphError(401, { error: { code: 190 } }));
    const result = await connect();
    expect(result).toMatchObject({
      outcome: 'needs_reconnect',
      channel: { status: 'needs_reconnect' },
    });
    const stored = await WhatsAppChannelModel.findById(result.channel.id).lean();
    expect(stored?.wabaCurrency).toBe('INR');
  });

  it('other Meta errors during setup → action needed at that step; bugs are rethrown after saving', async () => {
    w.fake.failNext(
      'getWaba',
      graphError(400, { error: { code: 100, message: 'Bad', type: 'GraphMethodException' } }),
    );
    const result = await connect();
    expect(result.channel.statusReason).toMatchObject({ code: 'meta_error', step: 'details' });
    w.fake.failNext('getWaba', new Error('kaboom') as never);
    const signup = fakeSignup();
    await expect(connect(signup)).rejects.toThrow('kaboom');
    const saved = await WhatsAppChannelModel.findOne({
      phoneNumberId: idsFor(signup).phoneNumberId,
    }).lean();
    expect(saved?.statusReason).toMatchObject({ code: 'setup_error', step: 'details' });
  });

  it('coexistence sync failures leave the channel connected', async () => {
    w.fake.failNext('requestCoexistenceSync');
    const result = await connect(fakeSignup({ mode: 'coexistence' }));
    expect(result.channel).toMatchObject({
      status: 'connected',
      coexistence: { contactsSync: 'failed', historySync: 'requested' },
    });
  });
});
