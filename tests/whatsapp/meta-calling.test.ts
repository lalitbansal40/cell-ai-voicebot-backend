import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSignedRequest, graphError, type WebhookEnvelope } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { callingClientFor, sealSecret } from '../../src/modules/whatsapp/context';
import { handleDataDeletion } from '../../src/modules/whatsapp/meta-callbacks.service';
import {
  ingestEnvelope,
  resetManagedNumbersCache,
} from '../../src/modules/whatsapp/webhooks.service';
import { createTestAccount, type TestAccount, type TestUser, tokenFor } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';
import {
  codeFor,
  fakeSignup,
  idsFor,
  insertChannel,
  userActor,
  useWhatsAppWorld,
  webhookFor,
} from '../helpers/whatsapp';

/** PMC: calls of a managed (Pinnacle) number over Meta Graph; messages stay on the partner. */
useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld({ PINNACLE_ENABLED: 'true' });

const FIELDS = ['messages', 'calls', 'account_settings_update', 'message_template_status_update'];
let acc: TestAccount;
let owner: TestUser;

beforeEach(async () => {
  acc = await createTestAccount();
  owner = await acc.addUser('owner');
  w.fake.setAppSubscriptionFields(FIELDS);
  resetManagedNumbersCache();
});
afterEach(() => {
  w.fake.setAppSubscriptionFields(FIELDS);
  vi.restoreAllMocks();
});

/** A managed number whose WABA / number exist at the fake Meta (same business + phone). */
const managed = async (signup = fakeSignup()) => {
  const ids = idsFor(signup);
  // the WABA / number exist at the fake Meta once a code for them was exchanged
  const { accessToken } = await w.fake.exchangeCode(codeFor(signup));
  const ch = await insertChannel({
    accountId: acc.account._id,
    provider: 'pinnacle',
    wabaId: ids.wabaId,
    phoneNumberId: ids.phoneNumberId,
    displayPhoneNumber: signup.phone,
    tokenSealed: sealSecret(w.ctx, 'pin_test_meta_calling_key_9876'),
    creditLine: { status: 'partner_active', allocationConfigId: null, error: null, at: new Date() },
    calling: {
      status: 'unavailable',
      unavailableReason: 'provider_unsupported',
    },
    pinnacle: {
      webhookUrl: 'https://example.test/hook',
      webhookSetAt: new Date(),
      keyLast4: '9876',
      keyCheckedAt: new Date(),
      lastBalanceErrorAt: null,
      addedBy: null,
    },
  } as never);
  return { signup, ids, id: ch._id.toString(), metaToken: accessToken };
};

const stored = (id: string) =>
  WhatsAppChannelModel.findById(id).select('+metaCalling.tokenSealed').lean<WhatsAppChannelDoc>();
const ops = () => w.fake.calls.map((c) => c.op);
const actor = () => userActor(owner.user._id);
const enable = (m: Awaited<ReturnType<typeof managed>>, code = codeFor(m.signup)) =>
  w.svc.enableMetaCalling(
    acc.account._id,
    m.id,
    { code, wabaId: m.ids.wabaId, phoneNumberId: m.ids.phoneNumberId },
    actor(),
    { allowToken: false },
  );

describe('Calling on (Meta direct) — PMC-T3', () => {
  it('same WABA / number: on, every step ok, token sealed and hidden, calling enabled, audited', async () => {
    const m = await managed();
    const r = await enable(m);
    expect(r.steps.map((s) => [s.key, s.ok])).toEqual([
      ['token', true],
      ['verify', true],
      ['app_subscribed', true],
      ['fields', true],
      ['calling_on', true],
    ]);
    const row = await stored(m.id);
    expect(row?.metaCalling).toMatchObject({
      status: 'on',
      method: 'embedded_signup',
      webhookCheck: { status: 'ok', appSubscribed: true },
      error: null,
    });
    expect(row?.metaCalling?.tokenSealed).toMatch(/\S/);
    expect(row?.metaCalling?.tokenSealed).not.toContain('fake_tok_');
    expect(row?.calling).toMatchObject({ status: 'enabled', unavailableReason: null });
    // messages still on the partner, calling on Meta
    expect(row?.provider).toBe('pinnacle');
    expect(callingClientFor(w.ctx, row!, 'pin_key').api).toBe(w.fake);
    // the Meta call settings are ON
    const settings = await w.fake.getPhoneSettings(m.metaToken, m.ids.phoneNumberId);
    expect(settings.status).toBe('ENABLED');
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.meta_calling_enabled',
      'target.id': m.id,
    }).lean();
    expect(audit?.meta).toMatchObject({ method: 'embedded_signup' });
    expect(JSON.stringify(audit)).not.toContain('fake_tok_');
  });

  it('another number in the popup → MISMATCH, nothing saved', async () => {
    const m = await managed();
    const other = fakeSignup();
    await expect(enable(m, codeFor(other))).rejects.toMatchObject({
      code: 'WHATSAPP_META_CALLING_MISMATCH',
    });
    const row = await stored(m.id);
    expect(row?.metaCalling?.status ?? 'off').toBe('off');
    expect(row?.metaCalling?.tokenSealed ?? null).toBeNull();
    // the ids the browser sends must match too
    await expect(
      w.svc.enableMetaCalling(
        acc.account._id,
        m.id,
        { code: codeFor(m.signup), wabaId: idsFor(other).wabaId },
        actor(),
        { allowToken: false },
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_META_CALLING_MISMATCH' });
  });

  it('missing WhatsApp scopes → SCOPES; a Meta number → NOT_MANAGED; a pasted token without the right → FORBIDDEN', async () => {
    const m = await managed();
    const real = w.fake.debugToken.bind(w.fake);
    vi.spyOn(w.fake, 'debugToken').mockImplementationOnce(async (t) => ({
      ...(await real(t)),
      scopes: ['whatsapp_business_messaging'],
    }));
    await expect(enable(m)).rejects.toMatchObject({ code: 'WHATSAPP_META_CALLING_SCOPES' });
    const meta = await insertChannel({ accountId: acc.account._id });
    await expect(
      w.svc.enableMetaCalling(acc.account._id, meta._id.toString(), { code: 'x' }, actor(), {
        allowToken: false,
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_META_CALLING_NOT_MANAGED' });
    await expect(
      w.svc.enableMetaCalling(
        acc.account._id,
        m.id,
        { accessToken: 'EAAG-system-user-token-0000000000' },
        actor(),
        { allowToken: false },
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_META_CALLING_TOKEN_FORBIDDEN' });
  });

  it('a System User token (platform team) works the same way', async () => {
    const m = await managed();
    const r = await w.svc.enableMetaCalling(
      acc.account._id,
      m.id,
      { accessToken: m.metaToken },
      actor(),
      { allowToken: true, byAdmin: true },
    );
    expect(r.channel.metaCalling).toMatchObject({
      status: 'on',
      method: 'system_user_token',
      tokenLast4: m.metaToken.slice(-4),
    });
  });

  it('the webhook repair fails → error at step webhook; Check / Fix repairs it → on', async () => {
    const m = await managed();
    w.fake.setAppSubscriptionFields(['messages']);
    w.fake.failNext(
      'setAppSubscription',
      graphError(400, { error: { code: 100, message: 'Callback verification failed' } }),
    );
    const r = await enable(m);
    expect(r.channel.metaCalling).toMatchObject({
      status: 'error',
      error: { step: 'webhook' },
    });
    expect(r.channel.calling).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'meta_calling_broken',
    });
    // the token is kept for the retry
    expect((await stored(m.id))?.metaCalling?.tokenSealed).toBeTruthy();
    const fixed = await w.svc.checkMetaCalling(acc.account._id, m.id, actor());
    expect(fixed.channel.metaCalling).toMatchObject({ status: 'on', error: null });
    expect(fixed.steps.find((s) => s.key === 'fields')?.ok).toBe(true);
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.meta_calling_checked',
        'target.id': m.id,
      }),
    ).toBe(1);
  });

  it('calling OFF at WhatsApp → turned ON at the fake Meta (never at the partner)', async () => {
    const m = await managed();
    await w.fake.updateCallingSettings(m.metaToken, m.ids.phoneNumberId, { status: 'DISABLED' });
    w.pinnacle.calls.length = 0;
    const before = ops().length;
    await enable(m);
    expect(ops().slice(before)).toContain('updateCallingSettings');
    expect(w.pinnacle.calls.map((c) => c.op)).not.toContain('updateCallingSettings');
    expect((await w.fake.getPhoneSettings(m.metaToken, m.ids.phoneNumberId)).status).toBe(
      'ENABLED',
    );
  });

  it('a token Meta stops accepting → check: error, bell once, calls refused', async () => {
    const m = await managed();
    await enable(m);
    await w.fake.revokeToken(m.metaToken);
    const row = await stored(m.id);
    // the token in the row is a new one from the same exchange path: revoke it too
    const { token } = callingClientFor(w.ctx, row!, 'pin');
    await w.fake.revokeToken(token);
    const r = await w.svc.checkMetaCalling(acc.account._id, m.id, actor());
    expect(r.channel.metaCalling).toMatchObject({
      status: 'error',
      error: { code: 'token_invalid' },
    });
    expect(r.channel.calling?.unavailableReason).toBe('meta_calling_broken');
    await w.svc.checkMetaCalling(acc.account._id, m.id, actor());
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.meta_calling_broken',
      }),
    ).toBe(1);
    const broken = await stored(m.id);
    expect(() => callingClientFor(w.ctx, broken!, 'pin')).toThrow(
      expect.objectContaining({ code: 'WA_META_CALLING_BROKEN' }),
    );
  });

  it('Calling off: token removed, back to the partner (provider_unsupported), audited; the sweep skips it', async () => {
    const m = await managed();
    await enable(m);
    const r = await w.svc.disableMetaCalling(
      acc.account._id,
      m.id,
      { turnOffAtWhatsApp: true },
      actor(),
    );
    expect(r).toMatchObject({ turnedOffAtWhatsApp: true, unsubscribed: true });
    const row = await stored(m.id);
    expect(row?.metaCalling).toMatchObject({ status: 'off', tokenSealed: null, method: null });
    expect(row?.calling).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'provider_unsupported',
    });
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.meta_calling_disabled',
        'target.id': m.id,
      }),
    ).toBe(1);
    expect(callingClientFor(w.ctx, row!, 'pin').via).toBe('pinnacle');
    await expect(
      w.svc.disableMetaCalling(acc.account._id, m.id, {}, actor()),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
  });

  it('daily sweep: checks numbers that are on, flags a broken one', async () => {
    const m = await managed();
    await enable(m);
    const ok = await w.svc.sweepMetaCalling(actor());
    expect(ok.checked).toBeGreaterThanOrEqual(1);
    const row = await stored(m.id);
    await w.fake.revokeToken(callingClientFor(w.ctx, row!, 'pin').token);
    await w.svc.sweepMetaCalling(actor());
    expect((await stored(m.id))?.metaCalling?.status).toBe('error');
  });

  it('6 tries per 10 minutes per number', async () => {
    const m = await managed();
    for (let i = 0; i < 6; i += 1) {
      await enable(m, 'not-a-code').catch(() => undefined);
    }
    await expect(enable(m)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('disconnect, data deletion and Switch to Meta direct clear the Meta calling token', async () => {
    const m = await managed();
    await enable(m);
    const userId = (await stored(m.id))?.metaCalling?.metaUserId;
    expect(userId).toBeTruthy();
    // data deletion by the Facebook user who granted it
    await handleDataDeletion(
      w.ctx,
      buildSignedRequest(
        { algorithm: 'HMAC-SHA256', user_id: userId, issued_at: Math.floor(Date.now() / 1000) },
        w.env.FAKE_META_APP_SECRET ?? '',
      ),
    );
    expect((await stored(m.id))?.metaCalling).toMatchObject({ status: 'off', tokenSealed: null });
    const m2 = await managed();
    await enable(m2);
    await w.svc.disconnect(acc.account._id, m2.id, actor());
    expect((await stored(m2.id))?.metaCalling).toMatchObject({ status: 'off', tokenSealed: null });
  });
});

describe('webhooks for a managed number with calls over Meta (PMC-T5)', () => {
  const envelopeOf = (fixture: string, ch: WhatsAppChannelDoc) =>
    webhookFor(fixture, ch) as unknown as WebhookEnvelope;
  const jobs = { enqueueEvent: () => Promise.resolve() };
  const count = (field: string, source: 'meta' | 'pinnacle', ch: WhatsAppChannelDoc) =>
    MetaWebhookEventModel.countDocuments({ field, source, phoneNumberId: ch.phoneNumberId });

  it('Meta: on → `calls` kept, `messages` dropped; off → both dropped. Relay: on → `calls` dropped, `messages` kept', async () => {
    const m = await managed();
    const off = (await stored(m.id))!;
    await ingestEnvelope(w.ctx, jobs, envelopeOf('calls-terminate-completed.json', off), {
      source: 'meta',
    });
    expect(await count('calls', 'meta', off)).toBe(0);

    await enable(m);
    resetManagedNumbersCache();
    const on = (await stored(m.id))!;
    await ingestEnvelope(w.ctx, jobs, envelopeOf('calls-connect-uic.json', on), { source: 'meta' });
    await ingestEnvelope(w.ctx, jobs, envelopeOf('messages-text-link.json', on), {
      source: 'meta',
    });
    await ingestEnvelope(w.ctx, jobs, envelopeOf('account-settings-update.json', on), {
      source: 'meta',
    });
    expect(await count('calls', 'meta', on)).toBe(1);
    expect(await count('messages', 'meta', on)).toBe(0);
    expect(await count('account_settings_update', 'meta', on)).toBe(1);

    const relayed = envelopeOf('calls-status-ringing.json', on);
    await ingestEnvelope(w.ctx, jobs, relayed, { source: 'pinnacle', channel: on });
    await ingestEnvelope(w.ctx, jobs, envelopeOf('messages-reaction.json', on), {
      source: 'pinnacle',
      channel: on,
    });
    expect(await count('calls', 'pinnacle', on)).toBe(0);
    expect(await count('messages', 'pinnacle', on)).toBe(1);
  });
});

describe('HTTP (PMC-T4)', () => {
  const appFor = () =>
    buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs: { enqueueEvent: () => Promise.resolve() } } });

  it('viewers read; owners turn on (no pasted token); full-access superadmin may paste; view login-as refused', async () => {
    const m = await managed();
    const app = appFor();
    const viewer = await acc.addUser('viewer');
    const path = `/api/v1/whatsapp/channels/${m.id}/meta-calling`;
    const read = await request(app).get(path).set('Authorization', `Bearer ${viewer.token}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ status: 'off' });
    expect(JSON.stringify(read.body)).not.toContain('tokenSealed');
    expect(
      (
        await request(app)
          .post(path)
          .set('Authorization', `Bearer ${viewer.token}`)
          .send({ code: codeFor(m.signup) })
      ).status,
    ).toBe(403);
    const pasted = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ accessToken: m.metaToken });
    expect(pasted.status).toBe(403);
    expect(pasted.body.error.code).toBe('WHATSAPP_META_CALLING_TOKEN_FORBIDDEN');

    const platform = await createTestAccount({ isPlatform: true });
    const sa = await platform.addUser('owner', { platformRole: 'superadmin' });
    const claims = (imm: 'full' | 'view') => ({
      sid: `imp_pmc_${imm}_${Date.now().toString(36)}`,
      imp: sa.user._id.toString(),
      imm,
      imk: 'superadmin' as const,
      ims: Math.floor(Date.now() / 1000),
    });
    const view = await tokenFor(owner.user, claims('view'));
    const blocked = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${view}`)
      .send({ code: codeFor(m.signup) });
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const full = await tokenFor(owner.user, claims('full'));
    const on = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${full}`)
      .send({ accessToken: m.metaToken });
    expect(on.status).toBe(200);
    expect(on.body.data.channel.metaCalling.status).toBe('on');
    expect(on.body.data.steps).toHaveLength(5);
    expect(JSON.stringify(on.body)).not.toContain(m.metaToken);

    const check = await request(app)
      .post(`${path}/check`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(check.status).toBe(200);
    const off = await request(app)
      .delete(path)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});
    expect(off.status).toBe(200);
    expect(off.body.data.channel.metaCalling.status).toBe('off');
  });

  it('admin twin: a superadmin turns it on with a token for any account', async () => {
    const m = await managed();
    const app = appFor();
    const platform = await createTestAccount({ isPlatform: true });
    const sa = await platform.addUser('owner', { platformRole: 'superadmin' });
    const res = await request(app)
      .post(`/api/v1/admin/whatsapp/channels/${m.id}/meta-calling`)
      .set('Authorization', `Bearer ${sa.token}`)
      .send({ accessToken: m.metaToken });
    expect(res.status).toBe(200);
    expect(res.body.data.channel.metaCalling).toMatchObject({ status: 'on' });
    expect(
      await AuditLogModel.findOne({ action: 'whatsapp.meta_calling_enabled', 'target.id': m.id })
        .select({ meta: 1 })
        .lean(),
    ).toMatchObject({ meta: { byAdmin: true, method: 'system_user_token' } });
    const missing = await request(app)
      .post(`/api/v1/admin/whatsapp/channels/${new Types.ObjectId().toString()}/meta-calling/check`)
      .set('Authorization', `Bearer ${sa.token}`);
    expect(missing.status).toBe(404);
  });

  it('config tells the browser whether the button is offered', async () => {
    const app = appFor();
    const res = await request(app)
      .get('/api/v1/whatsapp/config')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.body.data.metaCallingEnabled).toBe(true);
  });
});
