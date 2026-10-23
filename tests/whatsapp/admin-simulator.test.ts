import { Writable } from 'node:stream';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import { buildFakeCode } from '../../src/core/meta';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { createLogger, setLogger } from '../../src/shared/logger';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp, testEnv } from '../helpers/test-app';
import { codeFor, fakeSignup, idsFor, userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
const emails = useCapturedEmail();
const w = useWhatsAppWorld();

const logLines: string[] = [];
setLogger(
  createLogger(
    { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        logLines.push(chunk.toString());
        done();
      },
    }),
  ),
);
afterAll(() => setLogger(undefined));

const queued: string[] = [];
const jobs: WhatsAppJobs = { enqueueEvent: (id) => (queued.push(id), Promise.resolve()) };
const app = (extra: Partial<{ secret: string }> = {}) =>
  buildTestApp({ MOCK_APIS_ENABLED: 'true' }, { whatsapp: { ctx: w.ctx, jobs, ...extra } });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let platform: TestAccount;
let superadmin: TestUser;
let acc: TestAccount;
let owner: TestUser;
let manager: TestUser;
beforeAll(async () => {
  platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-wa-${Date.now()}`,
    name: 'Platform',
  });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});
beforeEach(async () => {
  acc = await createTestAccount();
  owner = await acc.addUser('owner');
  manager = await acc.addUser('manager');
  await acc.addUser('admin');
  queued.length = 0;
});

const connect = async () => {
  const signup = fakeSignup();
  const r = await w.svc.connect({
    accountId: acc.account._id,
    actor: userActor(owner.user._id),
    mode: 'cloud_api',
    code: codeFor(signup),
  });
  return { id: r.channel.id, ids: idsFor(signup), signup };
};
const drain = async () => {
  for (const id of queued.splice(0)) {
    await processWebhookEvent({ ctx: w.ctx, service: w.svc }, id, { finalAttempt: false });
  }
};
const channelOf = (id: string) => WhatsAppChannelModel.findById(id).lean<WhatsAppChannelDoc>();

describe('superadmin WhatsApp routes', () => {
  it('everyone but a superadmin gets 403 (impersonating superadmin too)', async () => {
    const { id } = await connect();
    const accId = acc.account._id.toString();
    const imp = await tokenFor(owner.user, { imp: superadmin.user._id.toString() });
    for (const token of [owner.token, manager.token, imp]) {
      for (const [method, url, body] of [
        ['get', '/api/v1/admin/whatsapp/status', undefined],
        ['get', '/api/v1/admin/whatsapp/events', undefined],
        ['post', `/api/v1/admin/whatsapp/events/${id}/replay`, {}],
        ['post', `/api/v1/admin/whatsapp/channels/${id}/disconnect`, { reason: 'abc' }],
        ['patch', `/api/v1/admin/accounts/${accId}/whatsapp-billing`, { metaPayer: 'customer' }],
        ['post', `/api/v1/admin/accounts/${accId}/whatsapp/manual-connect`, {}],
      ] as const) {
        const res = await request(app())[method](url).set(bearer(token)).send(body);
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    }
  });

  it('status: provider, configured flags (booleans), webhook URL, counts', async () => {
    await connect();
    const res = await request(app())
      .get('/api/v1/admin/whatsapp/status')
      .set(bearer(superadmin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      enabled: true,
      provider: 'fake',
      configured: {
        appSecret: true,
        verifyToken: true,
        creditLine: true,
        systemUserToken: true,
        appId: false,
      },
      webhookUrl: `${w.env.APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/meta`,
    });
    expect(res.body.data.channelsByStatus.connected).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain(w.env.FAKE_META_APP_SECRET ?? 'x');
    const off = buildTestApp({}, {});
    expect(
      (await request(off).get('/api/v1/admin/whatsapp/status').set(bearer(superadmin.token))).body
        .error.code,
    ).toBe('WHATSAPP_NOT_CONFIGURED');
  });

  it('failed events list (metadata only) + replay', async () => {
    const { id } = await connect();
    const sim = await request(app())
      .post('/api/v1/dev/meta/webhooks')
      .set(bearer(owner.token))
      .send({ channelId: id, kind: 'inbound_text' });
    expect(sim.status).toBe(200);
    const eventId = queued[0]!;
    await MetaWebhookEventModel.updateOne(
      { _id: eventId },
      { $set: { status: 'failed', error: 'schema: x' } },
    );
    queued.length = 0;
    const list = await request(app())
      .get('/api/v1/admin/whatsapp/events')
      .query({ status: 'failed' })
      .set(bearer(superadmin.token));
    const row = (list.body.data as { id: string }[]).find((e) => e.id === eventId);
    expect(row).toMatchObject({ field: 'messages', status: 'failed', error: 'schema: x' });
    expect(JSON.stringify(list.body)).not.toMatch(/payload|Test hello/);
    const replay = await request(app())
      .post(`/api/v1/admin/whatsapp/events/${eventId}/replay`)
      .set(bearer(superadmin.token));
    expect(replay.body.data).toEqual({ id: eventId, status: 'received' });
    expect(queued).toEqual([eventId]);
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.event_replayed',
        'target.id': eventId,
      }),
    ).toBe(1);
    const again = await request(app())
      .post(`/api/v1/admin/whatsapp/events/${eventId}/replay`)
      .set(bearer(superadmin.token));
    expect(again.status).toBe(409);
    const missing = await request(app())
      .post(`/api/v1/admin/whatsapp/events/${'0'.repeat(24)}/replay`)
      .set(bearer(superadmin.token));
    expect(missing.status).toBe(404);
    expect(
      (await request(app()).get('/api/v1/admin/whatsapp/events').set(bearer(superadmin.token)))
        .status,
    ).toBe(200);
  });

  it('billing mode: future connects use it, existing channels keep theirs; account detail summary', async () => {
    const { id } = await connect();
    const url = `/api/v1/admin/accounts/${acc.account._id.toString()}/whatsapp-billing`;
    const res = await request(app())
      .patch(url)
      .set(bearer(superadmin.token))
      .send({ metaPayer: 'customer' });
    expect(res.body.data).toEqual({
      metaPayer: 'customer',
      // Phase 11: the account's WhatsApp price override travels on the same route
      whatsappBilling: { markupBps: null, fixedPrices: null, platformFeeMicros: null },
    });
    await request(app()).patch(url).set(bearer(superadmin.token)).send({ metaPayer: 'customer' });
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.billing_mode_changed',
        'target.id': acc.account._id.toString(),
      }),
    ).toBe(2); // both sides, once
    expect((await channelOf(id))?.metaPayer).toBe('platform');
    const next = await connect();
    expect((await channelOf(next.id))?.metaPayer).toBe('customer');
    const detail = await request(app())
      .get(`/api/v1/admin/accounts/${acc.account._id.toString()}`)
      .set(bearer(superadmin.token));
    expect(detail.body.data.whatsappBilling).toEqual({
      metaPayer: 'customer',
      markupBps: null,
      fixedPrices: null,
      platformFeeMicros: null,
    });
    // the Phase 11 price override shows on the detail once set
    await request(app())
      .patch(url)
      .set(bearer(superadmin.token))
      .send({ markupBps: 2000, fixedPrices: { utility: 300_000 }, platformFeeMicros: 10_000 });
    const after = await request(app())
      .get(`/api/v1/admin/accounts/${acc.account._id.toString()}`)
      .set(bearer(superadmin.token));
    expect(after.body.data.whatsappBilling).toEqual({
      metaPayer: 'customer',
      markupBps: 2000,
      fixedPrices: { utility: 300_000 },
      platformFeeMicros: 10_000,
    });
    expect(detail.body.data.whatsappChannels).toHaveLength(2);
    expect(detail.body.data.whatsappChannels[0]).toMatchObject({
      status: 'connected',
      metaPayer: 'customer',
    });
    expect(JSON.stringify(detail.body)).not.toMatch(/tokenSealed|fake_tok_/);
    const platformUrl = `/api/v1/admin/accounts/${platform.account._id.toString()}/whatsapp-billing`;
    expect(
      (
        await request(app())
          .patch(platformUrl)
          .set(bearer(superadmin.token))
          .send({ metaPayer: 'customer' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app())
          .patch(`/api/v1/admin/accounts/${'0'.repeat(24)}/whatsapp-billing`)
          .set(bearer(superadmin.token))
          .send({ metaPayer: 'customer' })
      ).status,
    ).toBe(404);
  });

  it('force disconnect: reason, owner notification + email, audit both sides', async () => {
    const { id } = await connect();
    const res = await request(app())
      .post(`/api/v1/admin/whatsapp/channels/${id}/disconnect`)
      .set(bearer(superadmin.token))
      .send({ reason: 'Spam complaints' });
    expect(res.body.data.status).toBe('disconnected');
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.channel_disconnected_by_admin',
      }),
    ).toBe(2);
    expect(
      emails.some((e) => e.template === 'whatsapp.admin_disconnected' && e.to === owner.user.email),
    ).toBe(true);
    const audits = await AuditLogModel.find({
      action: 'whatsapp.channel_disconnected',
      'target.id': id,
    }).lean();
    expect(audits.map((a) => a.accountId.toString()).sort()).toEqual(
      [acc.account._id.toString(), platform.account._id.toString()].sort(),
    );
    expect(audits.every((a) => a.actor.platform)).toBe(true);
    expect(
      (
        await request(app())
          .post(`/api/v1/admin/whatsapp/channels/${'0'.repeat(24)}/disconnect`)
          .set(bearer(superadmin.token))
          .send({ reason: 'abc' })
      ).status,
    ).toBe(404);
  });

  it('manual connect with a token; refused without access to the WABA; suspended accounts refused', async () => {
    const signup = fakeSignup();
    const ids = idsFor(signup);
    const { accessToken } = await w.fake.exchangeCode(buildFakeCode(signup));
    const url = `/api/v1/admin/accounts/${acc.account._id.toString()}/whatsapp/manual-connect`;
    const bad = await request(app())
      .post(url)
      .set(bearer(superadmin.token))
      .send({ wabaId: '123456', phoneNumberId: ids.phoneNumberId, accessToken });
    expect(bad.body.error.code).toBe('WHATSAPP_SIGNUP_FAILED');
    const res = await request(app())
      .post(url)
      .set(bearer(superadmin.token))
      .send({ wabaId: ids.wabaId, phoneNumberId: ids.phoneNumberId, accessToken });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('connected');
    expect(JSON.stringify(res.body)).not.toContain(accessToken);
    expect(
      await AuditLogModel.findOne({
        action: 'whatsapp.channel_connected',
        'target.id': res.body.data.channel.id,
      }).lean(),
    ).toMatchObject({ meta: { manual: true }, actor: { platform: true } });
    await AccountModel.updateOne({ _id: acc.account._id }, { $set: { status: 'suspended' } });
    const suspended = await request(app())
      .post(url)
      .set(bearer(superadmin.token))
      .send({ wabaId: ids.wabaId, phoneNumberId: ids.phoneNumberId, accessToken });
    expect(suspended.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });
});

describe('dev webhook simulator', () => {
  const simulate = (token: string, body: object, target = app()) =>
    request(target).post('/api/v1/dev/meta/webhooks').set(bearer(token)).send(body);

  it('goes through the pipeline: quality downgrade, token revoked, payment method', async () => {
    const { id } = await connect();
    const res = await simulate(owner.token, { channelId: id, kind: 'quality_downgrade' });
    expect(res.body.data).toMatchObject({
      kind: 'quality_downgrade',
      field: 'phone_number_quality_update',
      received: 1,
    });
    await drain();
    expect(await channelOf(id)).toMatchObject({
      qualityRating: 'YELLOW',
      messagingLimitTier: 'TIER_250',
    });
    await simulate(owner.token, { channelId: id, kind: 'token_revoked' });
    await drain();
    expect((await channelOf(id))?.status).toBe('needs_reconnect');
    // a superadmin may simulate any account's number
    await AccountModel.updateOne(
      { _id: acc.account._id },
      { $set: { 'whatsapp.metaPayer': 'customer' } },
    );
    const customer = await connect();
    expect((await channelOf(customer.id))?.paymentMethodOk).toBe(false);
    await simulate(superadmin.token, { channelId: customer.id, kind: 'payment_method_added' });
    await drain();
    expect((await channelOf(customer.id))?.paymentMethodOk).toBe(true);
  });

  it('phone_number_added: an only-WABA signup gets its number through the pipeline', async () => {
    const signup = fakeSignup({ outcome: 'only_waba' });
    const r = await w.svc.connect({
      accountId: acc.account._id,
      actor: userActor(owner.user._id),
      mode: 'cloud_api',
      code: codeFor(signup),
      sessionInfo: { wabaId: idsFor(signup).wabaId },
    });
    expect(r.outcome).toBe('action_needed');
    const res = await simulate(owner.token, {
      channelId: r.channel.id,
      kind: 'phone_number_added',
    });
    expect(res.body.data).toMatchObject({ field: 'account_update', received: 1 });
    await drain();
    expect(await channelOf(r.channel.id)).toMatchObject({
      status: 'connected',
      phoneNumberId: idsFor(signup).phoneNumberId,
    });
  });

  it('a wrong signing secret is refused by the receiver (401)', async () => {
    const { id } = await connect();
    const res = await simulate(
      owner.token,
      { channelId: id, kind: 'inbound_text' },
      app({ secret: 'not-the-app-secret' }),
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('META_SIGNATURE_INVALID');
  });

  it('roles and isolation', async () => {
    const { id } = await connect();
    expect((await simulate(manager.token, { channelId: id, kind: 'flagged' })).status).toBe(403);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect((await simulate(stranger.token, { channelId: id, kind: 'flagged' })).status).toBe(404);
    expect(
      (await simulate(owner.token, { channelId: '0'.repeat(24), kind: 'flagged' })).status,
    ).toBe(404);
    expect((await simulate(owner.token, { channelId: id, kind: 'nope' })).status).toBe(422);
  });

  it('not mounted in production or without MOCK_APIS_ENABLED', async () => {
    const { id } = await connect();
    const off = buildTestApp({ MOCK_APIS_ENABLED: 'false' }, { whatsapp: { ctx: w.ctx, jobs } });
    expect((await simulate(owner.token, { channelId: id, kind: 'flagged' }, off)).status).toBe(404);
    const env = {
      ...testEnv({
        MOCK_APIS_ENABLED: 'true',
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
      NODE_ENV: 'production' as const,
    };
    const production = createApp({
      env,
      logger: createLogger(env),
      whatsapp: { ctx: w.ctx, jobs },
    });
    expect(
      (await simulate(owner.token, { channelId: id, kind: 'flagged' }, production)).status,
    ).toBe(404);
    expect(logLines.join('')).not.toMatch(/fake_tok_|Test hello from the simulator/);
  });
});
