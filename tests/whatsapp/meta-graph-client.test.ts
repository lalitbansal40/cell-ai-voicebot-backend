import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createGraphMetaClient,
  createMetaClient,
  metaAppSecret,
  MetaApiError,
  type GraphMetaClientOptions,
  type MetaEnv,
} from '../../src/core/meta';
import { createLogger } from '../../src/shared/logger';
import { json, useStubServer, type StubHandler } from '../helpers/stub-server';

const stub = useStubServer();
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '../fixtures/meta', name), 'utf8'));

const APP_SECRET = 'app-secret-0123456789abcdef0123456789';
const TOKEN = 'BUSINESS_TOKEN_abc123';
const SYSTEM_TOKEN = 'SYSTEM_USER_TOKEN_xyz789';
const CODE = 'SIGNUP_CODE_456';
const WABA = '102290129340398';
const PHONE = '106540352242922';

const logLines: string[] = [];
const logger = createLogger(
  { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
);
const waits: number[] = [];

const client = (over: Partial<GraphMetaClientOptions> = {}) =>
  createGraphMetaClient({
    appId: '1000000000000001',
    appSecret: APP_SECRET,
    graphVersion: 'v26.0',
    baseUrl: `${stub.url}/`,
    creditLineId: '1234567890',
    systemUserToken: SYSTEM_TOKEN,
    logger,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    ...over,
  });

const graphFail = (
  status: number,
  code: number,
  message = 'failed',
  extra: Record<string, unknown> = {},
): StubHandler =>
  json(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'trace', ...extra } });

const last = () => {
  const req = stub.requests.at(-1);
  if (!req) throw new Error('no request');
  const url = new URL(req.url, 'http://x');
  return { ...req, path: url.pathname, query: Object.fromEntries(url.searchParams) };
};

beforeEach(() => {
  stub.reset();
  waits.length = 0;
  logLines.length = 0;
});

describe('Graph client — calls', () => {
  it('exchangeCode: query credentials, no bearer', async () => {
    stub.next(json(200, fixture('graph-oauth-token.json')));
    expect(await client().exchangeCode(CODE)).toEqual({
      accessToken: 'TEST_BUSINESS_TOKEN',
      tokenType: 'bearer',
    });
    const req = last();
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v26.0/oauth/access_token');
    expect(req.query).toEqual({
      client_id: '1000000000000001',
      client_secret: APP_SECRET,
      code: CODE,
    });
    expect(req.headers.authorization).toBeUndefined();
  });

  it('debugToken: input_token + app token', async () => {
    stub.next(json(200, fixture('graph-debug-token.json')));
    const info = await client().debugToken(TOKEN);
    expect(info.grantedWabaIds).toEqual([WABA]);
    expect(last().query).toEqual({
      input_token: TOKEN,
      access_token: `1000000000000001|${APP_SECRET}`,
    });
    expect(last().path).toBe('/v26.0/debug_token');
  });

  it.each([
    ['listOwnedWabas', 'graph-me-wabas.json', '/v26.0/me/whatsapp_business_accounts', 'id,name'],
    [
      'listBusinessesWithWabas',
      'graph-me-businesses.json',
      '/v26.0/me/businesses',
      'id,name,owned_whatsapp_business_accounts{id,name}',
    ],
  ] as const)('%s → %s', async (method, file, path, fields) => {
    stub.next(json(200, fixture(file)));
    const result = await client()[method](TOKEN);
    expect(result.length).toBe(1);
    expect(last()).toMatchObject({ method: 'GET', path, query: { fields } });
    expect(last().headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('getWaba / listPhoneNumbers / getPhoneNumber', async () => {
    stub.next(
      json(200, fixture('graph-waba.json')),
      json(200, fixture('graph-phone-numbers.json')),
      json(200, fixture('graph-phone-number.json')),
    );
    const c = client();
    expect((await c.getWaba(TOKEN, WABA)).currency).toBe('INR');
    expect(last().path).toBe(`/v26.0/${WABA}`);
    expect(last().query.fields).toContain('primary_funding_id');
    expect((await c.listPhoneNumbers(TOKEN, WABA))[0]?.id).toBe(PHONE);
    expect(last()).toMatchObject({
      path: `/v26.0/${WABA}/phone_numbers`,
      query: { fields: 'id,display_phone_number,verified_name,status' },
    });
    expect((await c.getPhoneNumber(TOKEN, PHONE)).qualityRating).toBe('GREEN');
    expect(last().query.fields?.split(',')).toEqual(
      expect.arrayContaining([
        'quality_rating',
        'messaging_limit_tier',
        'is_on_biz_app',
        'throughput',
      ]),
    );
  });

  it('subscribe / unsubscribe / assign system user / register / coexistence sync', async () => {
    const ok = json(200, fixture('graph-success.json'));
    stub.next(
      ok,
      ok,
      ok,
      ok,
      json(200, fixture('graph-smb-app-data.json')),
      json(200, { success: true }),
    );
    const c = client();
    await c.subscribeApp(TOKEN, WABA);
    expect(last()).toMatchObject({
      method: 'POST',
      path: `/v26.0/${WABA}/subscribed_apps`,
      body: '',
    });
    await c.unsubscribeApp(TOKEN, WABA);
    expect(last()).toMatchObject({ method: 'DELETE', path: `/v26.0/${WABA}/subscribed_apps` });
    await c.assignSystemUser(TOKEN, WABA, '5000000000000001');
    expect(last()).toMatchObject({
      method: 'POST',
      path: `/v26.0/${WABA}/assigned_users`,
      query: { user: '5000000000000001', tasks: "['MANAGE']" },
    });
    await c.registerPhone(TOKEN, PHONE, '482913');
    expect(last()).toMatchObject({ method: 'POST', path: `/v26.0/${PHONE}/register` });
    expect(JSON.parse(last().body)).toEqual({ messaging_product: 'whatsapp', pin: '482913' });
    expect(last().headers['content-type']).toBe('application/json');
    expect(await c.requestCoexistenceSync(TOKEN, PHONE, 'smb_app_state_sync')).toEqual({
      requestId: '8000000000000001',
    });
    expect(last().path).toBe(`/v26.0/${PHONE}/smb_app_data`);
    expect(JSON.parse(last().body)).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'smb_app_state_sync',
    });
    expect(await c.requestCoexistenceSync(TOKEN, PHONE, 'history')).toEqual({ requestId: null });
  });

  it('credit line attach + allocation use the System User token', async () => {
    stub.next(
      json(200, fixture('graph-credit-line-attach.json')),
      json(200, fixture('graph-allocation.json')),
    );
    const c = client();
    expect(await c.attachCreditLine(WABA, 'INR')).toEqual({
      allocationConfigId: '6000000000000001',
    });
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/v26.0/1234567890/whatsapp_credit_sharing_and_attach',
      query: { waba_id: WABA, waba_currency: 'INR' },
    });
    expect(last().headers.authorization).toBe(`Bearer ${SYSTEM_TOKEN}`);
    expect(await c.getAllocation('6000000000000001')).toEqual({
      id: '6000000000000001',
      receivingCredentialId: '7000000000000001',
    });
    expect(last()).toMatchObject({
      path: '/v26.0/6000000000000001',
      query: { fields: 'receiving_credential' },
    });
  });

  it('credit line calls refuse without config (no request made)', async () => {
    await expect(
      client({ creditLineId: undefined }).attachCreditLine(WABA, 'INR'),
    ).rejects.toMatchObject({
      type: 'not_configured',
    });
    await expect(
      client({ systemUserToken: undefined }).attachCreditLine(WABA, 'INR'),
    ).rejects.toMatchObject({
      type: 'not_configured',
    });
    await expect(client({ systemUserToken: undefined }).getAllocation('1')).rejects.toMatchObject({
      type: 'not_configured',
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('getTokenOwner is cached per token', async () => {
    stub.next(json(200, fixture('graph-me.json')), json(200, { id: '77' }));
    const c = client();
    expect(await c.getTokenOwner(SYSTEM_TOKEN)).toBe('5000000000000001');
    expect(await c.getTokenOwner(SYSTEM_TOKEN)).toBe('5000000000000001');
    expect(stub.requests).toHaveLength(1);
    expect(last()).toMatchObject({ path: '/v26.0/me', query: { fields: 'id' } });
    expect(await c.getTokenOwner('OTHER')).toBe('77');
  });

  it('getTokenOwner cache is bounded', async () => {
    stub.always(json(200, { id: '1' }));
    const c = client();
    for (let i = 0; i < 101; i += 1) await c.getTokenOwner(`T${String(i)}`);
    await c.getTokenOwner('T0');
    expect(stub.requests).toHaveLength(102);
  });
});

describe('Graph client — retries and errors', () => {
  it('retries 5xx with exponential backoff, then succeeds', async () => {
    stub.next(graphFail(500, 2), graphFail(503, 1), json(200, fixture('graph-success.json')));
    await client().subscribeApp(TOKEN, WABA);
    expect(stub.requests).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('adds jitter to the backoff', async () => {
    stub.next(graphFail(500, 2), json(200, { success: true }));
    await client({ random: () => 0.5 }).subscribeApp(TOKEN, WABA);
    expect(waits).toEqual([750]);
  });

  it.each([1, 2, 4, 17, 32, 613, 80007])('retries Graph code %i', async (code) => {
    stub.next(graphFail(400, code), json(200, { success: true }));
    await client().subscribeApp(TOKEN, WABA);
    expect(stub.requests).toHaveLength(2);
  });

  it('gives up after 3 retries (4 attempts)', async () => {
    stub.always(graphFail(500, 2));
    const err = await client()
      .subscribeApp(TOKEN, WABA)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ status: 500, code: 2, retryable: true });
    expect(stub.requests).toHaveLength(4);
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it('does not retry other 4xx', async () => {
    stub.next(graphFail(400, 100, 'Invalid parameter'));
    await expect(client().getWaba(TOKEN, WABA)).rejects.toMatchObject({
      code: 100,
      retryable: false,
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('190 → tokenInvalid (no retry)', async () => {
    stub.next(json(401, fixture('graph-error-token-expired.json')));
    await expect(client().getPhoneNumber(TOKEN, PHONE)).rejects.toMatchObject({
      tokenInvalid: true,
      code: 190,
      subcode: 463,
      fbtraceId: 'AbCdEfGhIjK',
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('getWaba without primary_funding_id when Meta keeps it for Solution Providers', async () => {
    const bsp =
      'This action requires that the Business that owns this App is a Business Solution Provider for WhatsApp.';
    stub.next(graphFail(400, 10, bsp), json(200, fixture('graph-waba.json')));
    const waba = await client().getWaba(TOKEN, WABA);
    expect(waba.currency).toBe('INR');
    expect(waba.primaryFundingId).toBeNull();
    expect(stub.requests).toHaveLength(2);
    expect(last().query.fields).not.toContain('primary_funding_id');
    expect(last().query.fields).toContain('owner_business_info');
    // other errors are not retried without the field
    stub.next(graphFail(400, 100));
    await expect(client().getWaba(TOKEN, WABA)).rejects.toMatchObject({ code: 100 });
    expect(stub.requests).toHaveLength(3);
  });

  it('error body on HTTP 200 is an error', async () => {
    stub.next(graphFail(200, 100));
    await expect(client().getWaba(TOKEN, WABA)).rejects.toMatchObject({ status: 200, code: 100 });
  });

  it('non-JSON / wrong shape answers', async () => {
    const html: StubHandler = (_req, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
    const bad502: StubHandler = (_req, res) => res.writeHead(502).end('Bad gateway');
    stub.next(html, json(200, { nope: true }), bad502, bad502, bad502, bad502, (_r, res) =>
      res.writeHead(200).end(),
    );
    const c = client();
    await expect(c.getWaba(TOKEN, WABA)).rejects.toMatchObject({
      type: 'invalid_response',
      retryable: false,
    });
    await expect(c.getWaba(TOKEN, WABA)).rejects.toMatchObject({ type: 'invalid_response' });
    await expect(c.getWaba(TOKEN, WABA)).rejects.toMatchObject({ status: 502, retryable: true });
    // empty 200 body → null → shape mismatch
    await expect(c.subscribeApp(TOKEN, WABA)).rejects.toMatchObject({ type: 'invalid_response' });
  });

  it('timeout → retryable timeout error', async () => {
    stub.next(() => undefined);
    await expect(client({ timeoutMs: 50, retries: 0 }).getWaba(TOKEN, WABA)).rejects.toMatchObject({
      type: 'timeout',
      status: 0,
      retryable: true,
    });
  });

  it('network error → retryable network error', async () => {
    await expect(
      client({ baseUrl: 'http://127.0.0.1:1', retries: 1 }).getWaba(TOKEN, WABA),
    ).rejects.toMatchObject({ type: 'network', retryable: true });
    expect(waits).toEqual([500]);
  });

  it('never leaks tokens, secrets or codes in errors or logs', async () => {
    const echo =
      'Invalid OAuth access_token=BUSINESS_TOKEN_abc123 client_secret=app-secret-0123456789abcdef0123456789 code=SIGNUP_CODE_456 input_token=SYSTEM_USER_TOKEN_xyz789';
    stub.always(graphFail(400, 100, echo));
    const c = client();
    const errors = await Promise.all([
      c.exchangeCode(CODE).catch((e: unknown) => e),
      c.debugToken(TOKEN).catch((e: unknown) => e),
      c.getWaba(TOKEN, WABA).catch((e: unknown) => e),
      c.attachCreditLine(WABA, 'INR').catch((e: unknown) => e),
    ]);
    const text = [
      ...errors.map((e) => `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`),
      ...logLines,
    ].join('\n');
    for (const secret of [TOKEN, SYSTEM_TOKEN, APP_SECRET, CODE])
      expect(text).not.toContain(secret);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('')).not.toContain(stub.url);
  });
});

describe('Graph client — defaults', () => {
  it('real backoff timer and the app logger when none are given', async () => {
    stub.next(graphFail(500, 2), json(200, fixture('graph-debug-token.json')));
    const c = createGraphMetaClient({
      appId: '1',
      appSecret: APP_SECRET,
      graphVersion: 'v26.0',
      baseUrl: stub.url,
      retryBaseMs: 1,
    });
    expect((await c.debugToken(TOKEN)).isValid).toBe(true);
    expect(stub.requests).toHaveLength(2);
  });

  it('granular scopes without target ids grant nothing', async () => {
    stub.next(
      json(200, {
        data: { is_valid: true, granular_scopes: [{ scope: 'whatsapp_business_management' }] },
      }),
    );
    expect((await client().debugToken(TOKEN)).grantedWabaIds).toEqual([]);
  });
});

describe('createMetaClient', () => {
  const env: MetaEnv = {
    META_PROVIDER: 'fake',
    META_APP_ID: undefined,
    META_APP_SECRET: undefined,
    META_GRAPH_VERSION: 'v26.0',
    META_GRAPH_BASE_URL: 'https://graph.facebook.com',
    META_CREDIT_LINE_ID: undefined,
    META_SYSTEM_USER_TOKEN: undefined,
    FAKE_META_APP_SECRET: 'dev-fake-meta-app-secret',
    FAKE_META_STATUS_DELAYS_MS: null,
    FAKE_META_TEMPLATE_REVIEW_MS: null,
    APP_URL: 'http://localhost:5100',
  };
  const redis = {} as Redis;

  it('picks the provider and the app secret', async () => {
    expect(createMetaClient(env, { redis }).provider).toBe('fake');
    expect(createMetaClient(env, { redis, prefix: 'p:' }).provider).toBe('fake');
    expect(metaAppSecret(env)).toBe('dev-fake-meta-app-secret');
    expect(metaAppSecret({ ...env, FAKE_META_APP_SECRET: undefined })).toBe('');
    const metaEnv: MetaEnv = {
      ...env,
      META_PROVIDER: 'meta',
      META_APP_ID: '1',
      META_APP_SECRET: APP_SECRET,
      META_GRAPH_BASE_URL: stub.url,
      FAKE_META_APP_SECRET: undefined,
    };
    expect(metaAppSecret(metaEnv)).toBe(APP_SECRET);
    expect(metaAppSecret({ ...metaEnv, META_APP_SECRET: undefined })).toBe('');
    stub.next(json(200, { id: '9' }));
    const meta = createMetaClient(metaEnv, { redis, logger, fetch });
    expect(meta.provider).toBe('meta');
    expect(await meta.getTokenOwner(TOKEN)).toBe('9');
    expect(
      createMetaClient(
        { ...metaEnv, META_APP_ID: undefined, META_APP_SECRET: undefined },
        { redis },
      ).provider,
    ).toBe('meta');
  });
});
