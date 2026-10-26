import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildMessagePayload,
  createGraphMetaClient,
  MetaApiError,
  type GraphMetaClientOptions,
} from '../../src/core/meta';
import { createLogger } from '../../src/shared/logger';
import { json, useStubServer, type StubHandler } from '../helpers/stub-server';

const stub = useStubServer();
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '../fixtures/meta', name), 'utf8'));

const TOKEN = 'BUSINESS_TOKEN_inbox_123';
const PHONE = '106540352242922';
const CUSTOMER = '919000000101';

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

const client = (over: Partial<GraphMetaClientOptions> = {}) =>
  createGraphMetaClient({
    appId: '1000000000000001',
    appSecret: 'app-secret-0123456789abcdef0123456789',
    graphVersion: 'v26.0',
    baseUrl: stub.url,
    logger,
    sleep: () => Promise.resolve(),
    random: () => 0,
    mediaHosts: [`127.0.0.1:${String(stub.port)}`],
    ...over,
  });

const last = () => {
  const req = stub.requests.at(-1);
  if (!req) throw new Error('no request');
  const url = new URL(req.url, 'http://x');
  return { ...req, path: url.pathname, query: Object.fromEntries(url.searchParams) };
};
const bodyOf = () => JSON.parse(last().body) as Record<string, unknown>;

const bytes =
  (status: number, data: Buffer, headers: Record<string, string> = {}): StubHandler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'image/jpeg', ...headers });
    res.end(data);
  };

beforeEach(() => {
  stub.reset();
  logLines.length = 0;
});

describe('Graph client — messaging', () => {
  it('sendMessage posts the payload as JSON with the bearer token', async () => {
    stub.next(json(200, fixture('graph-message-sent.json')));
    const payload = buildMessagePayload(CUSTOMER, { type: 'text', body: 'Test hello' }, 'wamid.Q');
    const result = await client().sendMessage(TOKEN, PHONE, payload);
    expect(result).toEqual({ waMessageId: 'wamid.HBgMOTE5MDAwMDAwMTAxFQIAERgSSENTTEST' });
    expect(last()).toMatchObject({ method: 'POST', path: `/v26.0/${PHONE}/messages` });
    expect(last().headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(last().headers['content-type']).toBe('application/json');
    expect(bodyOf()).toEqual(payload);
  });

  it('sendMessage errors keep the Meta code (131047, 130429 retried)', async () => {
    stub.next(json(400, fixture('graph-error-window-closed.json')));
    const err = await client()
      .sendMessage(TOKEN, PHONE, buildMessagePayload(CUSTOMER, { type: 'text', body: 'x' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ code: 131047, retryable: false });

    // 130429 is not a Graph-level retry code: the send job decides (attempts / backoff)
    stub.next(json(400, fixture('graph-error-throughput.json')));
    await expect(
      client().sendMessage(
        TOKEN,
        PHONE,
        buildMessagePayload(CUSTOMER, { type: 'text', body: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 130429 });
    expect(stub.requests).toHaveLength(2);
    // transient Graph errors are retried by the client
    stub.next(
      json(500, { error: { code: 2, message: 'busy' } }),
      json(200, fixture('graph-message-sent.json')),
    );
    await client().sendMessage(
      TOKEN,
      PHONE,
      buildMessagePayload(CUSTOMER, { type: 'text', body: 'x' }),
    );
    expect(stub.requests).toHaveLength(4);
  });

  it('markRead sends the read receipt, with the typing indicator when asked', async () => {
    stub.next(json(200, { success: true }), json(200, { success: true }));
    await client().markRead(TOKEN, PHONE, 'wamid.IN');
    expect(bodyOf()).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
    });
    await client().markRead(TOKEN, PHONE, 'wamid.IN', { typing: true });
    expect(bodyOf()).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
      typing_indicator: { type: 'text' },
    });
    expect(last().path).toBe(`/v26.0/${PHONE}/messages`);
  });
});

describe('Graph client — media', () => {
  it('uploadMedia posts multipart (product, type, file) and retries with a fresh body', async () => {
    stub.next(
      json(503, { error: { code: 2, message: 'busy' } }),
      json(200, fixture('graph-media-upload.json')),
    );
    const id = await client().uploadMedia(TOKEN, PHONE, {
      bytes: Buffer.from('TESTFILE'),
      mimeType: 'application/pdf',
      fileName: 'test-statement.pdf',
    });
    expect(id).toBe('2000000000000001');
    expect(stub.requests).toHaveLength(2);
    const req = last();
    expect(req).toMatchObject({ method: 'POST', path: `/v26.0/${PHONE}/media` });
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toContain('name="messaging_product"');
    expect(req.body).toContain('whatsapp');
    expect(req.body).toContain('name="type"');
    expect(req.body).toContain('application/pdf');
    expect(req.body).toContain('filename="test-statement.pdf"');
    expect(req.body).toContain('TESTFILE');
    expect(stub.requests[0]?.body).toContain('TESTFILE');
  });

  it('uploadMedia gives up on non-retryable errors', async () => {
    stub.next(json(400, { error: { code: 131053, message: 'bad file' } }));
    await expect(
      client().uploadMedia(TOKEN, PHONE, {
        bytes: Buffer.from('x'),
        mimeType: 'image/png',
        fileName: 'a.png',
      }),
    ).rejects.toMatchObject({ code: 131053 });
    expect(stub.requests).toHaveLength(1);
  });

  it('getMediaUrl passes the phone number id and maps the answer', async () => {
    stub.next(json(200, fixture('graph-media-url.json')));
    expect(await client().getMediaUrl(TOKEN, '1000000000000001', PHONE)).toEqual({
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1000000000000001&ext=1761120000&hash=TEST',
      mimeType: 'image/jpeg',
      sha256: 'dGVzdC1zaGEyNTY=',
      size: 303833,
    });
    expect(last()).toMatchObject({
      method: 'GET',
      path: '/v26.0/1000000000000001',
      query: { phone_number_id: PHONE },
    });
    stub.next(json(200, { url: 'https://lookaside.fbsbx.com/x', file_size: 'n/a' }));
    expect(await client().getMediaUrl(TOKEN, 'm', PHONE)).toEqual({
      url: 'https://lookaside.fbsbx.com/x',
      mimeType: null,
      sha256: null,
      size: null,
    });
  });

  it('downloadMedia streams with the bearer token', async () => {
    const data = readFileSync(join(__dirname, '../fixtures/meta/media/sample.jpg'));
    stub.next(bytes(200, data, { 'content-length': String(data.length) }));
    const res = await client().downloadMedia(TOKEN, `${stub.url}/media/1?hash=x`, {
      maxBytes: 10_000,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(data);
    expect(res).toMatchObject({ contentType: 'image/jpeg', contentLength: data.length });
    expect(last().headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('downloadMedia refuses other hosts before any request, redirects and oversize bodies', async () => {
    await expect(
      client().downloadMedia(TOKEN, 'http://169.254.169.254/latest/meta-data', { maxBytes: 10 }),
    ).rejects.toMatchObject({ type: 'media_host_refused' });
    await expect(
      client({ mediaHosts: [] }).downloadMedia(TOKEN, `${stub.url}/m`, { maxBytes: 10 }),
    ).rejects.toMatchObject({ type: 'media_host_refused' });
    expect(stub.requests).toHaveLength(0);

    stub.next((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    });
    await expect(
      client().downloadMedia(TOKEN, `${stub.url}/m`, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(MetaApiError);

    // declared too large → refused at once
    stub.next(bytes(200, Buffer.alloc(50), { 'content-length': '50' }));
    await expect(
      client().downloadMedia(TOKEN, `${stub.url}/m`, { maxBytes: 10 }),
    ).rejects.toMatchObject({
      type: 'media_too_large',
    });
    // no length header → the stream aborts past maxBytes
    stub.next((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'transfer-encoding': 'chunked' });
      res.write(Buffer.alloc(8));
      res.end(Buffer.alloc(8));
    });
    const res = await client().downloadMedia(TOKEN, `${stub.url}/m`, { maxBytes: 10 });
    expect(res.contentLength).toBeNull();
    const consume = async () => {
      for await (const _chunk of res.stream) {
        // drain
      }
    };
    await expect(consume()).rejects.toMatchObject({ type: 'media_too_large' });

    stub.next(json(404, { error: { code: 100, message: 'gone' } }));
    await expect(
      client().downloadMedia(TOKEN, `${stub.url}/m`, { maxBytes: 10 }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a network failure during download is a retryable Meta error', async () => {
    const offline = createGraphMetaClient({
      appId: '1',
      appSecret: 's'.repeat(32),
      graphVersion: 'v26.0',
      baseUrl: stub.url,
      logger,
      mediaHosts: ['127.0.0.1:9'],
      fetch: () => Promise.reject(Object.assign(new Error('down'), { name: 'TypeError' })),
    });
    await expect(
      offline.downloadMedia(TOKEN, 'http://127.0.0.1:9/m', { maxBytes: 1 }),
    ).rejects.toMatchObject({
      type: 'network',
      retryable: true,
    });
    const slow = createGraphMetaClient({
      appId: '1',
      appSecret: 's'.repeat(32),
      graphVersion: 'v26.0',
      baseUrl: stub.url,
      logger,
      mediaHosts: ['127.0.0.1:9'],
      fetch: () => Promise.reject(Object.assign(new Error('slow'), { name: 'TimeoutError' })),
    });
    await expect(
      slow.downloadMedia(TOKEN, 'http://127.0.0.1:9/m', { maxBytes: 1 }),
    ).rejects.toMatchObject({
      type: 'timeout',
    });
  });
});

describe('Graph client — block users and business profile', () => {
  it('block / unblock post the Block Users body and report per-user results', async () => {
    stub.next(json(200, fixture('graph-block-users.json')));
    expect(await client().blockUsers(TOKEN, PHONE, [CUSTOMER, '919000000205'])).toEqual({
      done: [CUSTOMER],
      failed: [
        {
          waId: '919000000205',
          code: 139100,
          message: 'Failed to block user: the user has not messaged in the last 24 hours',
        },
      ],
    });
    expect(last()).toMatchObject({ method: 'POST', path: `/v26.0/${PHONE}/block_users` });
    expect(bodyOf()).toEqual({
      messaging_product: 'whatsapp',
      block_users: [{ user: CUSTOMER }, { user: '919000000205' }],
    });
    stub.next(json(200, fixture('graph-unblock-users.json')));
    expect(await client().unblockUsers(TOKEN, PHONE, [CUSTOMER])).toEqual({
      done: [CUSTOMER],
      failed: [],
    });
    expect(last().method).toBe('DELETE');
    stub.next(json(200, { block_users: { failed_users: [{ input: 'x' }] } }));
    expect((await client().blockUsers(TOKEN, PHONE, ['x'])).failed).toEqual([
      { waId: 'x', code: null, message: 'Meta refused the request' },
    ]);
  });

  it('business profile: get with fields, update with the product and photo handle', async () => {
    stub.next(json(200, fixture('graph-business-profile.json')));
    expect(await client().getBusinessProfile(TOKEN, PHONE)).toEqual({
      about: 'Test about',
      address: 'Test Road, Jaipur',
      description: 'Test description',
      email: 'hello@example.com',
      profilePictureUrl: 'https://pps.whatsapp.net/v/test.jpg',
      websites: ['https://example.com/'],
      vertical: 'FINANCE',
    });
    expect(last()).toMatchObject({
      method: 'GET',
      path: `/v26.0/${PHONE}/whatsapp_business_profile`,
      query: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
    });
    stub.next(json(200, { data: [{}] }));
    expect(await client().getBusinessProfile(TOKEN, PHONE)).toMatchObject({
      about: null,
      websites: [],
    });

    stub.next(json(200, { success: true }), json(200, { success: true }));
    await client().updateBusinessProfile(TOKEN, PHONE, {
      about: 'New',
      websites: ['https://a.example'],
    });
    expect(bodyOf()).toEqual({
      messaging_product: 'whatsapp',
      about: 'New',
      websites: ['https://a.example'],
    });
    await client().updateBusinessProfile(TOKEN, PHONE, { profilePictureHandle: 'h1' });
    expect(bodyOf()).toEqual({ messaging_product: 'whatsapp', profile_picture_handle: 'h1' });
    expect(last().path).toBe(`/v26.0/${PHONE}/whatsapp_business_profile`);
  });

  it('profile photo: resumable session, then the bytes with OAuth auth and offset 0', async () => {
    stub.next(
      json(200, fixture('graph-upload-session.json')),
      json(200, fixture('graph-upload-handle.json')),
    );
    const handle = await client().uploadProfilePhoto(TOKEN, Buffer.from('JPEGDATA'), 'image/jpeg');
    expect(handle).toBe('4::aW1hZ2UvanBlZw==:TESTHANDLE');
    const [session, upload] = stub.requests;
    const sessionUrl = new URL(session?.url ?? '', 'http://x');
    expect(sessionUrl.pathname).toBe('/v26.0/1000000000000001/uploads');
    expect(Object.fromEntries(sessionUrl.searchParams)).toEqual({
      file_length: '8',
      file_type: 'image/jpeg',
    });
    expect(session?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(upload?.url).toContain('/v26.0/upload:');
    expect(upload?.headers.authorization).toBe(`OAuth ${TOKEN}`);
    expect(upload?.headers.file_offset).toBe('0');
    expect(upload?.body).toBe('JPEGDATA');
  });

  it('never logs tokens, media URLs or bodies', async () => {
    stub.next(
      json(400, {
        error: { code: 131026, message: `failed https://lookaside.fbsbx.com/x?hash=1 ${TOKEN}` },
      }),
    );
    const err = (await client()
      .sendMessage(
        TOKEN,
        PHONE,
        buildMessagePayload(CUSTOMER, { type: 'text', body: 'Secret text' }),
      )
      .catch((e: unknown) => e)) as MetaApiError;
    expect(err.message).not.toContain('fbsbx');
    const logs = logLines.join('\n');
    for (const leak of [TOKEN, 'Secret text', CUSTOMER, 'fbsbx']) expect(logs).not.toContain(leak);
  });
});
