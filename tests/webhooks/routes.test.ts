import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { WEBHOOK_LIMITS } from '../../src/config/limits';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { WebhookDeliveryModel } from '../../src/db/models/webhook-delivery.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { generateApiKey } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { webhookPolicy } from '../../src/modules/webhooks/deliver.job';
import { recordingWebhookJobs, setWebhookJobs } from '../../src/modules/webhooks/jobs';
import { verify } from '../../src/modules/webhooks/signing';
import { resolvePublicAddress, urlBlockReason } from '../../src/shared/net/url-guard';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp, testEnv } from '../helpers/test-app';
import { useWebhookReceiver } from '../helpers/webhook-receiver';

useTestDb();
const receiver = useWebhookReceiver();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const app = buildTestApp(
  { AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' },
  { webhooks: receiver.hooks },
);
const BASE = '/api/v1/webhook-endpoints';

let a: TestAccount;
let owner: TestUser;
let manager: TestUser;

beforeEach(async () => {
  setWebhookJobs(recordingWebhookJobs());
  receiver.reset();
  a = await createTestAccount();
  owner = await a.addUser('owner');
  manager = await a.addUser('manager');
});

const create = (token: string, body: Record<string, unknown>) =>
  request(app)
    .post(BASE)
    .set(bearer(token))
    .send({ url: receiver.url(), events: ['call.completed'], ...body });

describe('endpoints CRUD', () => {
  it('creates (secret once, no-store), lists without secrets, changes, pauses and removes — audited by host', async () => {
    const res = await create(owner.token, {
      description: 'CRM',
      url: receiver.url('/hook?token=abc'),
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { endpoint, secret } = res.body.data as { endpoint: { id: string }; secret: string };
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint).toMatchObject({
      events: ['call.completed'],
      includePersonalData: false,
      active: true,
    });
    const stored = await WebhookEndpointModel.findById(endpoint.id).select('+secretSealed').lean();
    expect(stored?.secretSealed).not.toContain(secret);

    const list = await request(app).get(BASE).set(bearer(owner.token));
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toContain('secretSealed');

    const patched = await request(app)
      .patch(`${BASE}/${endpoint.id}`)
      .set(bearer(owner.token))
      .send({ events: ['*'], includePersonalData: true, description: 'CRM v2' });
    expect(patched.body.data).toMatchObject({
      events: ['*'],
      includePersonalData: true,
      description: 'CRM v2',
    });
    const paused = await request(app)
      .patch(`${BASE}/${endpoint.id}`)
      .set(bearer(owner.token))
      .send({ active: false });
    expect(paused.body.data).toMatchObject({ active: false, disabledReason: 'manual' });
    const enabled = await request(app)
      .post(`${BASE}/${endpoint.id}/enable`)
      .set(bearer(owner.token));
    expect(enabled.body.data).toMatchObject({
      active: true,
      disabledReason: null,
      failureStreak: 0,
    });

    const one = await request(app).get(`${BASE}/${endpoint.id}`).set(bearer(owner.token));
    expect(one.body.data.id).toBe(endpoint.id);
    expect(
      (await request(app).delete(`${BASE}/${endpoint.id}`).set(bearer(owner.token))).status,
    ).toBe(204);
    expect((await request(app).get(`${BASE}/${endpoint.id}`).set(bearer(owner.token))).status).toBe(
      404,
    );

    const audits = await AuditLogModel.find({ 'target.id': endpoint.id }).sort({ at: 1 }).lean();
    expect(audits.map((x) => x.action)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.updated',
      'webhook_endpoint.updated',
      'webhook_endpoint.enabled',
      'webhook_endpoint.deleted',
    ]);
    const text = JSON.stringify(audits);
    expect(text).toContain(`hooks.example.com:${String(receiver.port)}`);
    expect(text).not.toContain('token=abc');
    expect(text).not.toContain('/hook');
    expect(text).not.toContain(secret);
  });

  it('allows 10 endpoints per account', async () => {
    for (let i = 0; i < WEBHOOK_LIMITS.endpointsPerAccount; i += 1) {
      expect((await create(owner.token, {})).status).toBe(201);
    }
    const over = await create(owner.token, {});
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('WEBHOOK_ENDPOINT_LIMIT');
  });

  it.each([
    ['no events', { events: [] }],
    ['an unknown event', { events: ['call.exploded'] }],
    ['duplicate events', { events: ['call.started', 'call.started'] }],
    ['no url', { url: '' }],
    ['an unknown field', { secret: 'mine' }],
  ])('rejects %s', async (_n, body) => {
    expect((await create(owner.token, body)).status).toBe(422);
  });
});

describe('SSRF guard at save', () => {
  it.each([
    'http://127.0.0.1/hook',
    'http://10.1.2.3/hook',
    'http://172.16.0.1/hook',
    'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://0.0.0.0/hook',
    'http://2130706433/hook',
    'http://0177.0.0.1/hook',
    'http://localhost/hook',
    'http://user:pass@hooks.example.com/hook',
    'ftp://hooks.example.com/hook',
    'not a url',
  ])('refuses %s (422 WEBHOOK_URL_BLOCKED)', async (url) => {
    const res = await create(owner.token, { url });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WEBHOOK_URL_BLOCKED');
  });

  it('refuses names that resolve inside (rebinding: any private address in the answer)', async () => {
    const tricky = buildTestApp(
      { AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' },
      { webhooks: { resolve: () => Promise.resolve(['93.184.216.34', '10.0.0.7']) } },
    );
    const res = await request(tricky)
      .post(BASE)
      .set(bearer(owner.token))
      .send({ url: 'https://rebind.example.com/hook', events: ['*'] });
    expect(res.status).toBe(422);
    const missing = buildTestApp(
      { AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' },
      { webhooks: { resolve: () => Promise.reject(new Error('NXDOMAIN')) } },
    );
    const gone = await request(missing)
      .post(BASE)
      .set(bearer(owner.token))
      .send({ url: 'https://nowhere.example.com/hook', events: ['*'] });
    expect(gone.body.error.details[0].message).toBe('This address could not be found');
  });

  it('is https only in production, private hosts never; any port', async () => {
    const prod = webhookPolicy({
      NODE_ENV: 'production',
      AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: false,
      APP_URL: 'https://wa.notifynow.in',
    });
    expect(prod).toMatchObject({ httpsOnly: true, allowPrivate: false, anyPort: true });
    expect(urlBlockReason(new URL('http://hooks.example.com/x'), prod)).toBe('scheme');
    expect(urlBlockReason(new URL('https://hooks.example.com:9443/x'), prod)).toBeNull();
    expect(await resolvePublicAddress(new URL('https://10.0.0.1/x'), prod)).toEqual({
      ok: false,
      reason: 'private',
    });
    expect(
      await resolvePublicAddress(new URL('https://hooks.example.com/x'), prod, {
        resolve: () => Promise.resolve([]),
      }),
    ).toEqual({ ok: false, reason: 'network' });
    expect((await resolvePublicAddress(new URL('https://93.184.216.34/x'), prod)).ok).toBe(true);
    const dev = webhookPolicy(testEnv());
    expect(dev.httpsOnly).toBe(false);
  });
});

describe('access', () => {
  it('owners / admins and keys with webhooks:manage; not managers; tenant isolated', async () => {
    expect((await request(app).get(BASE).set(bearer(manager.token))).status).toBe(403);
    expect((await create(manager.token, {})).status).toBe(403);
    const key = generateApiKey(false);
    await ApiKeyModel.create({
      accountId: a.account._id,
      name: 'ops',
      prefix: key.slice(0, 13),
      keyHash: sha256Hex(key),
      scopes: ['webhooks:manage'],
      createdBy: owner.user._id,
    });
    const viaKey = await request(app)
      .post(BASE)
      .set('X-API-Key', key)
      .send({ url: receiver.url(), events: ['*'] });
    expect(viaKey.status).toBe(201);
    const audit = await AuditLogModel.findOne({
      action: 'webhook_endpoint.created',
      'target.id': viaKey.body.data.endpoint.id,
    }).lean();
    expect(audit?.actor.type).toBe('api_key');

    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    const id = viaKey.body.data.endpoint.id as string;
    for (const [method, path] of [
      ['get', `${BASE}/${id}`],
      ['patch', `${BASE}/${id}`],
      ['delete', `${BASE}/${id}`],
      ['post', `${BASE}/${id}/test`],
      ['post', `${BASE}/${id}/rotate-secret`],
      ['post', `${BASE}/${id}/enable`],
      ['get', `${BASE}/${id}/deliveries`],
    ] as const) {
      const r = request(app)[method](path).set(bearer(otherOwner.token));
      const res =
        method === 'patch'
          ? await r.send({ description: 'x' })
          : method === 'post' && path.endsWith('/test')
            ? await r.send({ type: 'call.started' })
            : await r;
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const listOther = await request(app).get(BASE).set(bearer(otherOwner.token));
    expect(listOther.body.data).toEqual([]);
  });
});

describe('test event and delivery log', () => {
  it('sends a signed sample now, returns the answer and logs a test delivery', async () => {
    const { endpoint, secret } = (await create(owner.token, {})).body.data as {
      endpoint: { id: string };
      secret: string;
    };
    receiver.reply({
      status: 201,
      body: '{"received":true}',
      headers: { 'content-type': 'application/json' },
    });
    const res = await request(app)
      .post(`${BASE}/${endpoint.id}/test`)
      .set(bearer(owner.token))
      .send({ type: 'call.completed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      ok: true,
      delivery: {
        test: true,
        status: 'succeeded',
        responseStatus: 201,
        responseSnippet: '{"received":true}',
      },
    });
    const got = receiver.received[0];
    const body = JSON.parse(got?.raw ?? '{}') as { type: string; data: Record<string, unknown> };
    expect(body.type).toBe('call.completed');
    expect(body.data).not.toHaveProperty('phone');
    expect(
      verify(
        String(got?.headers['x-webhook-signature']),
        [secret],
        got?.headers['x-webhook-timestamp'] as string,
        got?.raw ?? '',
      ),
    ).toBe(true);

    receiver.reply({ status: 500 });
    const failed = await request(app)
      .post(`${BASE}/${endpoint.id}/test`)
      .set(bearer(owner.token))
      .send({ type: 'whatsapp.message.status' });
    expect(failed.body.data).toMatchObject({
      ok: false,
      delivery: { status: 'failed', error: 'http_500' },
    });
    // a failed test never counts toward disabling
    expect((await WebhookEndpointModel.findById(endpoint.id).lean())?.failureStreak).toBe(0);
    // tests can't be replayed
    const replay = await request(app)
      .post(`/api/v1/webhook-deliveries/${String(failed.body.data.delivery.id)}/replay`)
      .set(bearer(owner.token));
    expect(replay.status).toBe(409);

    const log = await request(app)
      .get(`${BASE}/${endpoint.id}/deliveries?limit=1`)
      .set(bearer(owner.token));
    expect(log.body.data.items).toHaveLength(1);
    expect(log.body.data.items[0].type).toBe('whatsapp.message.status');
    const next = await request(app)
      .get(`${BASE}/${endpoint.id}/deliveries?limit=1&cursor=${String(log.body.data.nextCursor)}`)
      .set(bearer(owner.token));
    expect(next.body.data.items[0].type).toBe('call.completed');
    expect(next.body.data.nextCursor).toBeNull();
    const filtered = await request(app)
      .get(
        `${BASE}/${endpoint.id}/deliveries?status=succeeded&type=call.completed&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
      )
      .set(bearer(owner.token));
    expect(filtered.body.data.items).toHaveLength(1);
    expect(
      await WebhookDeliveryModel.countDocuments({ endpointId: new Types.ObjectId(endpoint.id) }),
    ).toBe(2);
  });
});
