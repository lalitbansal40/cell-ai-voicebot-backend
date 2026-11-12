import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import { json, useStubServer } from '../../../tests/helpers/stub-server';
import { createLogger } from '../../shared/logger';

import { isProviderBalanceLow, isProviderUnsupported, PROVIDER_ERROR_TYPES } from './errors';
import { createGraphMetaClient } from './graph.client';
import { createPinnacleClient, PINNACLE_UNSUPPORTED } from './pinnacle.client';
import { MetaApiError } from './types';

const stub = useStubServer();
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/meta', name), 'utf8'));

const KEY = 'pin_live_key_0123456789abcdef';
const WABA = '922498337028205';
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

const client = () =>
  createPinnacleClient({
    baseUrl: `${stub.url}/`,
    voiceBaseUrl: `${stub.url}/voice`,
    logger,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });

const last = () => {
  const req = stub.requests.at(-1);
  if (!req) throw new Error('no request');
  const url = new URL(req.url, 'http://x');
  return { ...req, path: url.pathname, query: Object.fromEntries(url.searchParams) };
};

const failed = (message: string) => json(200, { code: 100, status: 'failed', message });

beforeEach(() => {
  stub.reset();
  logLines.length = 0;
});

describe('Pinnacle client — coverage', () => {
  it('handles every MetaClient method (relayed, remapped or unsupported)', () => {
    const graph = createGraphMetaClient({
      appId: '1',
      appSecret: 'x'.repeat(32),
      graphVersion: 'v26.0',
      baseUrl: 'http://127.0.0.1:9',
    });
    const metaMethods = Object.keys(graph).filter((k) => k !== 'provider');
    const pin = client() as unknown as Record<string, unknown>;
    for (const m of metaMethods) expect(typeof pin[m], m).toBe('function');
    expect(PINNACLE_UNSUPPORTED.every((m) => metaMethods.includes(m))).toBe(true);
    expect(pin.provider).toBe('pinnacle');
  });

  it.each(PINNACLE_UNSUPPORTED)('%s → provider_unsupported, no request', async (method) => {
    const fn = (client() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
      method
    ];
    const err: unknown = await fn?.(KEY, WABA).catch((e: unknown) => e);
    expect(isProviderUnsupported(err)).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('Pinnacle client — relayed Graph paths', () => {
  it('sends with the apikey header (never Authorization) on /v3', async () => {
    stub.next(json(200, fixture('graph-message-sent.json')));
    const res = await client().sendMessage(KEY, PHONE, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919000000001',
      type: 'text',
      text: { body: 'hi' },
    });
    expect(res.waMessageId).toMatch(/^wamid\./);
    const req = last();
    expect(req).toMatchObject({ method: 'POST', path: `/v3/${PHONE}/messages` });
    expect(req.headers.apikey).toBe(KEY);
    expect(req.headers.authorization).toBeUndefined();
  });

  it('templates, WABA, mark read, block, register, settings, permissions', async () => {
    const c = client();
    stub.next(json(200, fixture('graph-templates-page1.json')));
    await c.listTemplates(KEY, WABA);
    expect(last().path).toBe(`/v3/${WABA}/message_templates`);
    stub.next(json(200, fixture('graph-template-created.json')));
    await c.createTemplate(KEY, WABA, {
      name: 'hello',
      language: 'en',
      category: 'UTILITY',
      parameterFormat: 'positional',
      components: [{ type: 'BODY', text: 'Hi' }],
    });
    expect(last()).toMatchObject({ method: 'POST', path: `/v3/${WABA}/message_templates` });
    stub.next(json(200, fixture('graph-success.json')));
    await c.editTemplate(KEY, '555', { components: [] });
    expect(last().path).toBe('/v3/555');
    stub.next(json(200, fixture('graph-success.json')));
    await c.deleteTemplate(KEY, WABA, { name: 'hello', hsmId: '555' });
    expect(last()).toMatchObject({
      method: 'DELETE',
      query: { name: 'hello', hsm_id: '555' },
    });
    stub.next(json(200, fixture('graph-waba.json')));
    expect((await c.getWaba(KEY, WABA)).currency).toBe('INR');
    expect(last().path).toBe(`/v3/${WABA}`);
    stub.next(json(200, fixture('graph-success.json')));
    await c.markRead(KEY, PHONE, 'wamid.1');
    expect(JSON.parse(last().body)).toMatchObject({ status: 'read', message_id: 'wamid.1' });
    stub.next(json(200, fixture('graph-block-users.json')));
    await c.blockUsers(KEY, PHONE, ['919000000001']);
    expect(last().path).toBe(`/v3/${PHONE}/block_users`);
    stub.next(json(200, fixture('graph-success.json')));
    await c.registerPhone(KEY, PHONE, '123456');
    expect(last().path).toBe(`/v3/${PHONE}/register`);
    stub.next(json(200, fixture('graph-phone-settings.json')));
    await c.getPhoneSettings(KEY, PHONE);
    expect(last().path).toBe(`/v3/${PHONE}/settings`);
    stub.next(json(200, fixture('graph-call-permissions.json')));
    await c.getCallPermissions(KEY, PHONE, '919000000001');
    expect(last()).toMatchObject({
      path: `/v3/${PHONE}/call_permissions`,
      query: { user_wa_id: '919000000001' },
    });
    for (const r of stub.requests) expect(r.headers.apikey).toBe(KEY);
  });

  it('business/… paths for phone numbers and the profile', async () => {
    const c = client();
    stub.next(json(200, fixture('graph-phone-numbers.json')));
    await c.listPhoneNumbers(KEY, WABA);
    expect(last().path).toBe(`/v3/business/${WABA}/phone_numbers`);
    stub.next(json(200, fixture('graph-phone-number.json')));
    expect((await c.getPhoneNumber(KEY, PHONE)).qualityRating).toBe('GREEN');
    expect(last().path).toBe(`/v3/business/${PHONE}`);
    stub.next(json(200, fixture('graph-business-profile.json')));
    await c.getBusinessProfile(KEY, PHONE);
    expect(last().path).toBe(`/v3/business/${PHONE}/whatsapp_business_profile`);
    stub.next(json(200, fixture('graph-success.json')));
    await c.updateBusinessProfile(KEY, PHONE, { about: 'Hello' });
    expect(last()).toMatchObject({
      method: 'POST',
      path: `/v3/business/${PHONE}/whatsapp_business_profile`,
    });
  });

  it('calls go to the voice host with the same bodies', async () => {
    const c = client();
    stub.next(json(200, fixture('graph-call-connect.json')));
    const { waCallId } = await c.startCall(KEY, PHONE, {
      to: '919000000001',
      sdpOffer: 'v=0 offer',
    });
    expect(waCallId).toBeTruthy();
    expect(last().path).toBe(`/voice/v3/${PHONE}/calls`);
    expect(JSON.parse(last().body)).toMatchObject({
      action: 'connect',
      session: { sdp_type: 'offer', sdp: 'v=0 offer' },
    });
    for (const [action, run] of [
      ['pre_accept', () => c.preAcceptCall(KEY, PHONE, 'wacid.1', 'v=0 a')],
      ['accept', () => c.acceptCall(KEY, PHONE, 'wacid.1', 'v=0 a', 'opaque')],
      ['reject', () => c.rejectCall(KEY, PHONE, 'wacid.1')],
      ['terminate', () => c.terminateCall(KEY, PHONE, 'wacid.1')],
    ] as const) {
      stub.next(json(200, { success: true }));
      await run();
      expect(last().path).toBe(`/voice/v3/${PHONE}/calls`);
      expect(JSON.parse(last().body)).toMatchObject({ action, call_id: 'wacid.1' });
      expect(last().headers.apikey).toBe(KEY);
    }
  });
});

describe('Pinnacle client — media and uploads', () => {
  it('media URL points at the direct download; download is a POST with the key', async () => {
    const c = client();
    stub.next(json(200, fixture('graph-media-url.json')));
    const info = await c.getMediaUrl(KEY, 'media-1', PHONE);
    expect(last()).toMatchObject({ path: '/v3/media-1', query: { phone_number_id: PHONE } });
    expect(info.url).toBe(`${stub.url}/v3/downloadMedia/media-1?phone_number_id=${PHONE}`);
    stub.next((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '3' });
      res.end(Buffer.from([1, 2, 3]));
    });
    const dl = await c.downloadMedia(KEY, info.url, { maxBytes: 10 });
    const chunks: Buffer[] = [];
    for await (const chunk of dl.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(last()).toMatchObject({ method: 'POST', path: '/v3/downloadMedia/media-1' });
    expect(last().headers.apikey).toBe(KEY);
  });

  it('refuses downloads from other hosts / paths and past the size cap', async () => {
    const c = client();
    await expect(
      c.downloadMedia(KEY, 'https://lookaside.fbsbx.com/x', { maxBytes: 10 }),
    ).rejects.toMatchObject({ type: 'media_host_refused' });
    await expect(
      c.downloadMedia(KEY, `${stub.url}/v3/other`, { maxBytes: 10 }),
    ).rejects.toMatchObject({ type: 'media_host_refused' });
    stub.next((_req, res) => {
      res.writeHead(200, { 'content-length': '50' });
      res.end(Buffer.alloc(50));
    });
    await expect(
      c.downloadMedia(KEY, `${stub.url}/v3/downloadMedia/m?phone_number_id=1`, { maxBytes: 10 }),
    ).rejects.toMatchObject({ type: 'media_too_large' });
  });

  it('uploads: app/uploads session then the bytes, both with apikey', async () => {
    stub.next(
      json(200, { id: 'upload:abc?sig=xyz' }),
      json(200, fixture('graph-upload-handle.json')),
    );
    const handle = await client().uploadExample(KEY, {
      bytes: Buffer.from('img'),
      mimeType: 'image/png',
      fileName: 'a.png',
    });
    expect(handle).toBeTruthy();
    const [session, upload] = stub.requests;
    expect(session?.url).toContain('/v3/app/uploads?');
    expect(session?.url).toContain('file_length=3');
    expect(upload?.url).toBe('/v3/upload:abc?sig=xyz');
    expect(upload?.headers.apikey).toBe(KEY);
    expect(upload?.headers.authorization).toBeUndefined();
    expect(upload?.headers.file_offset).toBe('0');
  });
});

describe('Pinnacle client — extras', () => {
  it('getUserDetails maps the numbers of the key', async () => {
    stub.next(
      json(200, {
        code: 200,
        status: 'SUCCESS',
        data: [
          {
            whatsapp_business_account_id: WABA,
            wanumber: '+919921447944',
            phone_number_id: 111266881902966,
          },
        ],
      }),
    );
    expect(await client().getUserDetails(KEY)).toEqual([
      { wabaId: WABA, phoneNumberId: '111266881902966', displayPhoneNumber: '+919921447944' },
    ]);
    expect(last()).toMatchObject({ method: 'GET', path: '/v3/getuserdetails' });
  });

  it('setWebhook / getWebhook', async () => {
    const c = client();
    stub.next(json(200, { code: '200', status: 'Success', message: 'configured' }));
    await c.setWebhook(KEY, PHONE, 'https://api.example.test/hook', {
      'x-cell-webhook-secret': 's',
    });
    expect(last()).toMatchObject({ method: 'POST', path: `/v3/${PHONE}/setwebhook` });
    expect(JSON.parse(last().body)).toEqual({
      webhook_url: 'https://api.example.test/hook',
      headers: { 'x-cell-webhook-secret': 's' },
    });
    stub.next(
      json(200, {
        webhook_url: 'https://api.example.test/hook',
        headers: { 'x-cell-webhook-secret': 's', n: 1 },
      }),
    );
    expect(await c.getWebhook(KEY, PHONE)).toEqual({
      url: 'https://api.example.test/hook',
      headers: { 'x-cell-webhook-secret': 's' },
    });
    stub.next(json(200, { webhook_url: '', headers: {} }));
    expect(await c.getWebhook(KEY, PHONE)).toBeNull();
  });
});

describe('Pinnacle client — errors', () => {
  it('"Insufficient Balance" with HTTP 200 → provider_balance_low, not retried', async () => {
    stub.next(failed('Insufficient Balance'));
    const err: unknown = await client()
      .sendMessage(KEY, PHONE, { messaging_product: 'whatsapp' } as never)
      .catch((e: unknown) => e);
    expect(isProviderBalanceLow(err)).toBe(true);
    expect(err).toMatchObject({ retryable: false, tokenInvalid: false });
    expect(stub.requests).toHaveLength(1);
  });

  it('401 / invalid key → tokenInvalid', async () => {
    stub.next(json(401, { status: 'failed', message: 'Invalid API key' }));
    await expect(client().getUserDetails(KEY)).rejects.toMatchObject({ tokenInvalid: true });
    stub.next(failed('Invalid apikey supplied'));
    await expect(client().getUserDetails(KEY)).rejects.toMatchObject({ tokenInvalid: true });
  });

  it('other failed bodies → provider_error with the message', async () => {
    stub.next(failed('Template not allowed'));
    await expect(client().listTemplates(KEY, WABA)).rejects.toMatchObject({
      type: PROVIDER_ERROR_TYPES.error,
      message: 'Template not allowed',
    });
  });

  it('Meta-shaped errors relayed by Pinnacle keep their Graph code', async () => {
    stub.next(json(400, fixture('graph-error-window-closed.json')));
    const err: unknown = await client()
      .sendMessage(KEY, PHONE, { messaging_product: 'whatsapp' } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe(131047);
  });

  it('5xx retried, then provider_error', async () => {
    stub.next(json(503, {}), json(503, {}), json(503, {}), json(503, {}), json(503, {}));
    await expect(client().getWaba(KEY, WABA)).rejects.toMatchObject({
      type: PROVIDER_ERROR_TYPES.error,
      status: 503,
    });
    expect(stub.requests.length).toBeGreaterThan(1);
  });

  it('never logs the key', async () => {
    stub.next(json(401, { status: 'failed', message: `Invalid API key apikey=${KEY}` }));
    const err = (await client()
      .getUserDetails(KEY)
      .catch((e: unknown) => e)) as MetaApiError;
    expect(err.message).not.toContain(KEY);
    expect(logLines.join('\n')).not.toContain(KEY);
  });
});
