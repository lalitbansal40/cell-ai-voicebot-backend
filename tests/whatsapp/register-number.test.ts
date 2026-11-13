import type { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { open } from '../../src/core/ai/secret-box';
import { FAKE_EXISTING_PIN, graphError, type MetaClient } from '../../src/core/meta';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { createWhatsAppService } from '../../src/modules/whatsapp/whatsapp.service';
import type { AppError } from '../../src/shared/errors/app-error';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { codeFor, fakeSignup, idsFor, userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld({ PINNACLE_ENABLED: 'true' });

let acc: TestAccount;
let ownerId: Types.ObjectId;
beforeEach(async () => {
  acc = await createTestAccount();
  ownerId = (await acc.addUser('owner')).user._id;
});

let n = 0;
const unique = (name: string) => {
  n += 1;
  return `${name} ${String(Date.now())} ${String(n)}`;
};
/** The service with `WHATSAPP_REGISTER_PIN` set (the fake's "existing" PIN). */
const withPin = () =>
  createWhatsAppService({
    ...w.ctx,
    env: { ...w.ctx.env, WHATSAPP_REGISTER_PIN: FAKE_EXISTING_PIN },
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
const pinSignup = () => fakeSignup({ phone: '+91 90000 00001', businessName: unique('Pin Co') });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as AppError,
  );
const pinOf = async (id: string) => {
  const ch = await WhatsAppChannelModel.findById(id)
    .select('+registration.pinSealed')
    .lean<WhatsAppChannelDoc>();
  return open(w.ctx.key, ch?.registration.pinSealed ?? '');
};
const addManaged = async (
  svc: ReturnType<typeof createWhatsAppService>,
  phone: string,
): Promise<{ id: string; outcome: string }> => {
  const num = await w.pinnacle.seedManagedNumber({
    businessName: unique('Managed'),
    phone,
    registered: false,
  });
  const r = await svc.connectManaged({
    accountId: acc.account._id,
    actor: userActor(),
    label: 'Managed line',
    wabaId: num.wabaId,
    phoneNumberId: num.phoneNumberId,
    apiKey: num.apiKey,
    creditLine: 'partner_active',
  });
  return { id: r.channel.id, outcome: r.outcome };
};

describe('register with the configured PIN', () => {
  it('connect registers a PIN-protected number at once with WHATSAPP_REGISTER_PIN', async () => {
    const r = await connect(pinSignup(), {}, withPin());
    expect(r.outcome).toBe('connected');
    expect(r.channel).toMatchObject({
      registration: { status: 'registered' },
      canRegister: false,
    });
    expect(await pinOf(r.channel.id)).toBe(FAKE_EXISTING_PIN);
  });

  it('a managed number that is still pending is registered when it is added', async () => {
    w.pinnacle.calls.length = 0;
    const r = await addManaged(withPin(), '+91 98111 00001');
    expect(r.outcome).toBe('connected');
    expect(w.pinnacle.calls.map((c) => c.op)).toContain('registerPhone');
    const ch = await WhatsAppChannelModel.findById(r.id).lean<WhatsAppChannelDoc>();
    expect(ch).toMatchObject({ phoneStatus: 'CONNECTED', registration: { status: 'registered' } });
    expect(await pinOf(r.id)).toBe(FAKE_EXISTING_PIN);
  });

  it('"Register number" without a PIN uses the configured one', async () => {
    const pending = await connect(pinSignup());
    expect(pending.channel).toMatchObject({
      statusReason: { code: 'pin_required' },
      canRegister: true,
    });
    const done = await withPin().submitPin(
      acc.account._id,
      pending.channel.id,
      undefined,
      userActor(ownerId),
    );
    expect(done).toMatchObject({ outcome: 'connected', channel: { canRegister: false } });
  });
});

describe('"Register number" without a configured PIN', () => {
  it('a number that asked for its PIN needs it typed in', async () => {
    const pending = await connect(pinSignup());
    expect(
      await failure(
        w.svc.submitPin(acc.account._id, pending.channel.id, undefined, userActor(ownerId)),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'pin' }] });
    const done = await w.svc.submitPin(
      acc.account._id,
      pending.channel.id,
      FAKE_EXISTING_PIN,
      userActor(ownerId),
    );
    expect(done.outcome).toBe('connected');
  });

  it('managed number: a random PIN registers a fresh number on add', async () => {
    const r = await addManaged(w.svc, '+91 98222 00002');
    expect(r.outcome).toBe('connected');
    expect(await pinOf(r.id)).toMatch(/^\d{6}$/);
  });

  it('managed number with a PIN already set: pin_required, then registered through the partner', async () => {
    const r = await addManaged(w.svc, '+91 98333 00001');
    expect(r.outcome).toBe('action_needed');
    const ch = await WhatsAppChannelModel.findById(r.id).lean<WhatsAppChannelDoc>();
    expect(ch?.statusReason?.code).toBe('pin_required');
    w.pinnacle.calls.length = 0;
    const wrong = await failure(
      w.svc.submitPin(acc.account._id, r.id, '111111', userActor(ownerId)),
    );
    expect(wrong).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'pin' }] });
    const done = await w.svc.submitPin(
      acc.account._id,
      r.id,
      FAKE_EXISTING_PIN,
      userActor(ownerId),
    );
    expect(done).toMatchObject({
      outcome: 'connected',
      channel: { registration: { status: 'registered' }, canRegister: false },
    });
    expect(w.pinnacle.calls.filter((c) => c.op === 'registerPhone')).toHaveLength(2);
    expect(
      (await failure(w.svc.submitPin(acc.account._id, r.id, undefined, userActor(ownerId))))?.code,
    ).toBe('CONFLICT_INVALID_STATE');
  });
});

describe('WABA discovery when the popup sent no WABA', () => {
  const noGrants = (over: Partial<MetaClient>) =>
    createWhatsAppService({
      ...w.ctx,
      meta: {
        ...w.fake,
        debugToken: async (t) => ({ ...(await w.fake.debugToken(t)), grantedWabaIds: [] }),
        ...over,
      },
    });
  const nonexisting = () =>
    graphError(400, {
      error: {
        message: '(#100) Tried accessing nonexisting field (whatsapp_business_accounts)',
        type: 'OAuthException',
        code: 100,
      },
    });

  it('Meta #100 on the owned-WABA lookup falls back to businesses', async () => {
    const svc = noGrants({ listOwnedWabas: () => Promise.reject(nonexisting()) });
    const r = await connect(
      fakeSignup({ businessName: unique('Disc') }),
      { sessionInfo: undefined },
      svc,
    );
    expect(r.outcome).toBe('connected');
  });

  it('both lookups failing: the popup WABA is used', async () => {
    const svc = noGrants({
      listOwnedWabas: () => Promise.reject(nonexisting()),
      listBusinessesWithWabas: () => Promise.reject(nonexisting()),
    });
    const signup = fakeSignup({ businessName: unique('Hint') });
    const r = await connect(signup, { sessionInfo: { wabaId: idsFor(signup).wabaId } }, svc);
    expect(r.outcome).toBe('connected');
    const none = await failure(
      connect(fakeSignup({ businessName: unique('None') }), { sessionInfo: undefined }, svc),
    );
    expect(none).toMatchObject({
      code: 'WHATSAPP_SIGNUP_FAILED',
      message: 'No WhatsApp Business Account was shared.',
    });
  });
});
