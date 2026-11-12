import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FakeManagedNumber } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { openSecret } from '../../src/modules/whatsapp/context';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import {
  PINNACLE_SECRET_HEADER,
  pinnacleWebhookUrl,
} from '../../src/modules/whatsapp/pinnacle-webhooks.service';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';
import { userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
const w = useWhatsAppWorld({ PINNACLE_ENABLED: 'true' });

const jobs: WhatsAppJobs = { enqueueEvent: () => Promise.resolve() };
const app = () => buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs } });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let platform: TestAccount;
let superadmin: TestUser;
let acc: TestAccount;
let owner: TestUser;

beforeAll(async () => {
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-pn-${String(Date.now())}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});
beforeEach(async () => {
  acc = await createTestAccount();
  owner = await acc.addUser('owner');
  w.pinnacle.ignoreWebhookWrites(false);
});

let n = 0;
const seed = (keyPrefix?: string): Promise<FakeManagedNumber> => {
  n += 1;
  return w.pinnacle.seedManagedNumber({
    businessName: `Managed ${String(Date.now())} ${String(n)}`,
    phone: `+91 97${String(Date.now()).slice(-3)} ${String(n).padStart(5, '0')}`,
    ...(keyPrefix ? { keyPrefix } : {}),
  });
};

const addUrl = () =>
  `/api/v1/admin/accounts/${acc.account._id.toString()}/whatsapp/managed-numbers`;
const add = (
  num: FakeManagedNumber,
  over: Record<string, unknown> = {},
  token = superadmin.token,
) =>
  request(app())
    .post(addUrl())
    .set(bearer(token))
    .send({
      label: 'Managed line',
      wabaId: num.wabaId,
      phoneNumberId: num.phoneNumberId,
      apiKey: num.apiKey,
      creditLine: 'partner_active',
      ...over,
    });
const channelOf = (id: string) =>
  WhatsAppChannelModel.findById(id)
    .select('+tokenSealed +pinnacle.webhookSecretSealed')
    .lean<WhatsAppChannelDoc>();

describe('add a managed number (PN-T5)', () => {
  it('credit line active → connected: key sealed, webhook set at the partner, audit without the key', async () => {
    const num = await seed();
    const res = await add(num);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      outcome: 'connected',
      channel: { provider: 'pinnacle', managed: true, status: 'connected' },
    });
    expect(JSON.stringify(res.body)).not.toContain(num.apiKey);
    const ch = (await channelOf(res.body.data.channel.id as string))!;
    expect(ch.tokenSealed).not.toContain(num.apiKey);
    expect(openSecret(w.ctx, ch.tokenSealed ?? '')).toBe(num.apiKey);
    expect(ch).toMatchObject({
      metaPayer: 'platform',
      mode: 'cloud_api',
      creditLine: { status: 'partner_active' },
      subscription: { status: 'subscribed' },
      pinnacle: { keyLast4: num.apiKey.slice(-4) },
    });
    const secret = openSecret(w.ctx, ch.pinnacle?.webhookSecretSealed ?? '');
    expect(await w.pinnacle.getWebhook(num.apiKey, num.phoneNumberId)).toEqual({
      url: pinnacleWebhookUrl(w.env, ch._id),
      headers: { [PINNACLE_SECRET_HEADER]: secret },
    });
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.managed_number_added',
      'target.id': ch._id.toString(),
    }).lean();
    expect(audit).toMatchObject({
      actor: { platform: true },
      meta: { keyLast4: num.apiKey.slice(-4) },
    });
    expect(JSON.stringify(audit)).not.toContain(num.apiKey);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('credit line requested → action needed (partner_credit_line_pending)', async () => {
    const res = await add(await seed(), { creditLine: 'partner_pending' });
    expect(res.status).toBe(201);
    expect(res.body.data.outcome).toBe('action_needed');
    expect(res.body.data.channel.statusReason.code).toBe('partner_credit_line_pending');
  });

  it('invalid key / number not on the key / wrong WABA → 422', async () => {
    const num = await seed();
    expect((await add(num, { apiKey: 'pin_bad_0123456789' })).body.error.code).toBe(
      'PINNACLE_KEY_INVALID',
    );
    const other = await seed();
    expect((await add(num, { apiKey: other.apiKey })).body.error.code).toBe(
      'PINNACLE_NUMBER_NOT_ON_KEY',
    );
    expect((await add(num, { wabaId: other.wabaId })).body.error.code).toBe(
      'PINNACLE_NUMBER_NOT_ON_KEY',
    );
    expect(await WhatsAppChannelModel.countDocuments({ phoneNumberId: num.phoneNumberId })).toBe(0);
  });

  it('a number active anywhere → 409 WHATSAPP_NUMBER_IN_USE', async () => {
    const num = await seed();
    expect((await add(num)).status).toBe(201);
    const res = await add(num);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WHATSAPP_NUMBER_IN_USE');
  });

  it('the partner keeps no webhook / refuses → 502 and nothing left behind', async () => {
    const num = await seed();
    w.pinnacle.ignoreWebhookWrites(true);
    const ignored = await add(num);
    expect(ignored.status).toBe(502);
    expect(ignored.body.error.code).toBe('PINNACLE_WEBHOOK_NOT_SET');
    w.pinnacle.ignoreWebhookWrites(false);
    w.pinnacle.failNext('setWebhook');
    expect((await add(num)).body.error.code).toBe('PINNACLE_WEBHOOK_NOT_SET');
    expect(await WhatsAppChannelModel.countDocuments({ phoneNumberId: num.phoneNumberId })).toBe(0);
    expect((await add(num)).status).toBe(201);
  });

  it('validation: digits ids, key without spaces, label required', async () => {
    const num = await seed();
    const res = await add(num, { apiKey: 'has space key', label: '' });
    expect(res.status).toBe(422);
  });

  it('owners and impersonating superadmins get 403', async () => {
    const num = await seed();
    expect((await add(num, {}, owner.token)).status).toBe(403);
    const imp = await tokenFor(owner.user, { imp: superadmin.user._id.toString() });
    expect((await add(num, {}, imp)).status).toBe(403);
  });

  it('PINNACLE_ENABLED off → 503 WA_PROVIDER_NOT_CONFIGURED', async () => {
    const off = buildTestApp(
      {},
      {
        whatsapp: {
          ctx: { ...w.ctx, env: { ...w.ctx.env, PINNACLE_ENABLED: false } },
          jobs,
        },
      },
    );
    const num = await seed();
    const res = await request(off).post(addUrl()).set(bearer(superadmin.token)).send({
      label: 'x',
      wabaId: num.wabaId,
      phoneNumberId: num.phoneNumberId,
      apiKey: num.apiKey,
      creditLine: 'partner_active',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('WA_PROVIDER_NOT_CONFIGURED');
  });

  it('superadmin account view: provider, managed, partner details without secrets', async () => {
    const num = await seed();
    await add(num);
    const res = await request(app())
      .get(`/api/v1/admin/accounts/${acc.account._id.toString()}`)
      .set(bearer(superadmin.token));
    expect(res.status).toBe(200);
    const row = (res.body.data.whatsappChannels as Record<string, unknown>[])[0];
    expect(row).toMatchObject({
      provider: 'pinnacle',
      managed: true,
      pinnacle: { keyLast4: num.apiKey.slice(-4) },
    });
    expect(JSON.stringify(res.body)).not.toContain(num.apiKey);
    const status = await request(app())
      .get('/api/v1/admin/whatsapp/status')
      .set(bearer(superadmin.token));
    expect(status.body.data.pinnacle).toMatchObject({
      enabled: true,
      baseUrl: 'https://partnersv1.pinbot.ai',
    });
  });
});

describe('managed number actions (PN-T5)', () => {
  const managed = async (creditLine = 'partner_active') => {
    const num = await seed();
    const res = await add(num, { creditLine });
    return { num, id: res.body.data.channel.id as string };
  };
  const action = (id: string, path: string, body: Record<string, unknown> = {}) =>
    request(app())
      .post(`/api/v1/admin/whatsapp/channels/${id}/managed/${path}`)
      .set(bearer(superadmin.token))
      .send(body);

  it('replace the key: checked, sealed, webhook set with it, audit last4 only', async () => {
    const { num, id } = await managed();
    // a second key for the same number (the partner issued a new one)
    const again = await w.pinnacle.seedManagedNumber({
      businessName: (await channelOf(id))!.businessName ?? '',
      phone: (await channelOf(id))!.displayPhoneNumber ?? '',
    });
    expect((await action(id, 'api-key', { apiKey: 'pin_bad_123456789' })).body.error.code).toBe(
      'PINNACLE_KEY_INVALID',
    );
    const res = await action(id, 'api-key', { apiKey: again.apiKey });
    expect(res.status).toBe(200);
    const ch = (await channelOf(id))!;
    expect(openSecret(w.ctx, ch.tokenSealed ?? '')).toBe(again.apiKey);
    expect(ch.pinnacle?.keyLast4).toBe(again.apiKey.slice(-4));
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.managed_key_replaced',
      'target.id': id,
    }).lean();
    expect(audit?.meta).toMatchObject({
      fromLast4: num.apiKey.slice(-4),
      toLast4: again.apiKey.slice(-4),
    });
  });

  it('reset the webhook: a new secret at the partner', async () => {
    const { num, id } = await managed();
    const before = openSecret(w.ctx, (await channelOf(id))!.pinnacle?.webhookSecretSealed ?? '');
    const res = await action(id, 'webhook');
    expect(res.status).toBe(200);
    const after = openSecret(w.ctx, (await channelOf(id))!.pinnacle?.webhookSecretSealed ?? '');
    expect(after).not.toBe(before);
    expect((await w.pinnacle.getWebhook(num.apiKey, num.phoneNumberId))?.headers).toEqual({
      [PINNACLE_SECRET_HEADER]: after,
    });
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.managed_webhook_reset',
        'target.id': id,
      }),
    ).toBe(1);
  });

  it('credit line requested → active moves the number to connected (and back)', async () => {
    const { id } = await managed('partner_pending');
    expect((await channelOf(id))!.status).toBe('action_needed');
    const active = await action(id, 'credit-line', { status: 'partner_active' });
    expect(active.body.data).toMatchObject({
      status: 'connected',
      billing: { creditLine: { status: 'partner_active' } },
    });
    const pending = await action(id, 'credit-line', { status: 'partner_pending' });
    expect(pending.body.data.statusReason.code).toBe('partner_credit_line_pending');
    expect(
      await AuditLogModel.findOne({ action: 'whatsapp.credit_line_updated', 'target.id': id })
        .sort({ _id: 1 })
        .lean(),
    ).toMatchObject({ meta: { from: 'partner_pending', to: 'partner_active' } });
  });

  it('actions on a Meta number → 409; unknown → 404', async () => {
    const meta = await WhatsAppChannelModel.create({
      accountId: acc.account._id,
      label: 'Meta',
      provider: 'fake',
      mode: 'cloud_api',
      wabaId: 'fake_waba_000000000001',
      phoneNumberId: `fake_phone_${String(Date.now()).slice(-12).padStart(12, '0')}`,
      metaPayer: 'platform',
      status: 'connected',
    });
    expect((await action(meta._id.toString(), 'webhook')).status).toBe(409);
    expect((await action('64b000000000000000000000', 'webhook')).status).toBe(404);
  });

  it('disconnect: partner webhook cleared, key and secret wiped, can be added again', async () => {
    const { num, id } = await managed();
    await w.svc.disconnect(acc.account._id, id, userActor(owner.user._id));
    const ch = (await channelOf(id))!;
    expect(ch.status).toBe('disconnected');
    expect(ch.tokenSealed).toBeNull();
    expect(ch.pinnacle?.webhookSecretSealed).toBeNull();
    expect(await w.pinnacle.getWebhook(num.apiKey, num.phoneNumberId)).toBeNull();
    expect((await add(num)).status).toBe(201);
  });

  it('PIN register and coexistence sync are refused; retry setup checks at the partner', async () => {
    const { id } = await managed('partner_pending');
    await expect(w.svc.submitPin(acc.account._id, id, '123456', userActor())).rejects.toMatchObject(
      { code: 'CONFLICT_INVALID_STATE' },
    );
    await expect(
      w.svc.retryCoexistenceSync(acc.account._id, id, userActor()),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
    const retried = await w.svc.retrySetup(acc.account._id, id, userActor());
    expect(retried.outcome).toBe('action_needed');
    expect(w.pinnacle.calls.some((c) => c.op === 'getUserDetails')).toBe(true);
  });

  it('owners see "managed" but no partner details', async () => {
    const { num, id } = await managed();
    const res = await request(app())
      .get(`/api/v1/whatsapp/channels/${id}`)
      .set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ managed: true, provider: 'pinnacle' });
    expect(res.body.data.pinnacle).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(num.apiKey);
    expect(JSON.stringify(res.body)).not.toContain('webhookSecret');
  });
});

describe('dev: seed a managed number (PN-T9)', () => {
  const dev = () => buildTestApp({ MOCK_APIS_ENABLED: 'true' }, { whatsapp: { ctx: w.ctx, jobs } });

  it('a superadmin gets a test key that Add managed number accepts; others 403', async () => {
    const seeded = await request(dev())
      .post('/api/v1/dev/meta/managed-number')
      .set(bearer(superadmin.token))
      .send({});
    expect(seeded.status).toBe(200);
    expect(seeded.body.data.apiKey).toMatch(/^pin_test_/);
    const added = await request(dev()).post(addUrl()).set(bearer(superadmin.token)).send({
      label: 'Demo',
      wabaId: seeded.body.data.wabaId,
      phoneNumberId: seeded.body.data.phoneNumberId,
      apiKey: seeded.body.data.apiKey,
      creditLine: 'partner_active',
    });
    expect(added.status).toBe(201);
    const denied = await request(dev())
      .post('/api/v1/dev/meta/managed-number')
      .set(bearer(owner.token))
      .send({});
    expect(denied.status).toBe(403);
  });
});
