import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import { createGraphMetaClient, MetaApiError, mapCallError } from '../../src/core/meta';
import { createLogger } from '../../src/shared/logger';
import { json, useStubServer } from '../helpers/stub-server';

const stub = useStubServer();
const raw = (name: string) => readFileSync(join(__dirname, '../fixtures/meta', name), 'utf8');
const fixture = (name: string): unknown => JSON.parse(raw(name));

const TOKEN = 'BUSINESS_TOKEN_abc123';
const PHONE = '106540352242922';
const CALL = 'wacid.HBgMOTE5MDAwMDAwMTAxFQIAEhggRDEyMzQ1Njc4OUFCQ0RFRjAA';
const OFFER = raw('calls-sdp-offer.txt');
const ANSWER = raw('calls-sdp-answer.txt');

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
  createGraphMetaClient({
    appId: '1000000000000001',
    appSecret: 'app-secret-0123456789abcdef0123456789',
    graphVersion: 'v23.0',
    baseUrl: stub.url,
    logger,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });

const last = () => {
  const req = stub.requests.at(-1);
  if (!req) throw new Error('no request');
  const url = new URL(req.url, 'http://x');
  return {
    ...req,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    json: req.body ? (JSON.parse(req.body) as Record<string, unknown>) : null,
  };
};

const success = json(200, { messaging_product: 'whatsapp', success: true });

/** Nothing SDP-like may reach a log line (IPs, ICE credentials, fingerprints). */
const expectNoSdpInLogs = () => {
  const all = logLines.join('\n');
  for (const bit of ['v=0', 'a=candidate', 'ice-pwd', 'ice-ufrag', 'fingerprint', '203.0.113.10']) {
    expect(all).not.toContain(bit);
  }
};

beforeEach(() => {
  stub.reset();
  logLines.length = 0;
});

describe('Graph client — WhatsApp calling', () => {
  it('startCall: connect with the SDP offer and our opaque id → Meta call id', async () => {
    stub.next(json(200, fixture('graph-call-connect.json')));
    const { waCallId } = await client().startCall(TOKEN, PHONE, {
      to: '919000000101',
      sdpOffer: OFFER,
      bizOpaque: 'call_1',
    });
    expect(waCallId).toBe(CALL);
    const req = last();
    expect(req).toMatchObject({ method: 'POST', path: `/v23.0/${PHONE}/calls` });
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.json).toEqual({
      messaging_product: 'whatsapp',
      to: '919000000101',
      action: 'connect',
      session: { sdp_type: 'offer', sdp: OFFER },
      biz_opaque_callback_data: 'call_1',
    });
    // a BSUID-only customer goes as `recipient`
    stub.next(json(200, fixture('graph-call-connect.json')));
    await client().startCall(TOKEN, PHONE, { recipient: 'IN.123', sdpOffer: OFFER });
    expect(last().json).toEqual({
      messaging_product: 'whatsapp',
      recipient: 'IN.123',
      action: 'connect',
      session: { sdp_type: 'offer', sdp: OFFER },
    });
    expectNoSdpInLogs();
  });

  it('pre_accept / accept / reject / terminate bodies', async () => {
    stub.next(success, success, success, success, success);
    const c = client();
    await c.preAcceptCall(TOKEN, PHONE, CALL, ANSWER);
    expect(last().json).toEqual({
      messaging_product: 'whatsapp',
      call_id: CALL,
      action: 'pre_accept',
      session: { sdp_type: 'answer', sdp: ANSWER },
    });
    await c.acceptCall(TOKEN, PHONE, CALL, ANSWER, 'call_1');
    expect(last().json).toEqual({
      messaging_product: 'whatsapp',
      call_id: CALL,
      action: 'accept',
      session: { sdp_type: 'answer', sdp: ANSWER },
      biz_opaque_callback_data: 'call_1',
    });
    await c.acceptCall(TOKEN, PHONE, CALL, ANSWER);
    expect(last().json).not.toHaveProperty('biz_opaque_callback_data');
    await c.rejectCall(TOKEN, PHONE, CALL);
    expect(last().json).toEqual({ messaging_product: 'whatsapp', call_id: CALL, action: 'reject' });
    await c.terminateCall(TOKEN, PHONE, CALL);
    expect(last().json).toEqual({
      messaging_product: 'whatsapp',
      call_id: CALL,
      action: 'terminate',
    });
    expect(
      stub.requests.every((r) => new URL(r.url, 'http://x').pathname === `/v23.0/${PHONE}/calls`),
    ).toBe(true);
  });

  it('settings: GET calling block + restrictions; POST only the calling body', async () => {
    stub.next(json(200, fixture('graph-phone-settings.json')), json(200, { success: true }));
    const c = client();
    const s = await c.getPhoneSettings(TOKEN, PHONE);
    expect(last()).toMatchObject({ method: 'GET', path: `/v23.0/${PHONE}/settings` });
    expect(s.status).toBe('ENABLED');
    expect(s.restrictions[0]?.type).toBe('RESTRICTED_BUSINESS_INITIATED_CALLING');
    await c.updateCallingSettings(TOKEN, PHONE, { status: 'DISABLED' });
    expect(last()).toMatchObject({ method: 'POST', path: `/v23.0/${PHONE}/settings` });
    expect(last().json).toEqual({ calling: { status: 'DISABLED' } });
  });

  it('call permissions: user_wa_id for a phone, recipient for a BSUID', async () => {
    stub.next(
      json(200, fixture('graph-call-permissions.json')),
      json(200, fixture('graph-call-permissions.json')),
    );
    const c = client();
    const p = await c.getCallPermissions(TOKEN, PHONE, '919000000101');
    expect(p.status).toBe('temporary');
    expect(last()).toMatchObject({
      method: 'GET',
      path: `/v23.0/${PHONE}/call_permissions`,
      query: { user_wa_id: '919000000101' },
    });
    await c.getCallPermissions(TOKEN, PHONE, 'IN.1234567890123456');
    expect(last().query).toEqual({ recipient: 'IN.1234567890123456' });
  });

  it('errors: 138006 is not retried and maps to permission missing; no SDP in the error', async () => {
    stub.next(json(400, fixture('graph-error-call-permission.json')));
    const err = await client()
      .startCall(TOKEN, PHONE, { to: '919000000101', sdpOffer: OFFER })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe(138006);
    expect(mapCallError(err as MetaApiError).code).toBe('WHATSAPP_CALL_PERMISSION_MISSING');
    expect(stub.requests).toHaveLength(1);
    expectNoSdpInLogs();
  });

  it('errors that echo the SDP are scrubbed; 5xx is retried', async () => {
    stub.next(
      json(500, { error: { message: `Bad offer ${OFFER}`, code: 2, type: 'OAuthException' } }),
      json(200, fixture('graph-call-connect.json')),
    );
    const { waCallId } = await client().startCall(TOKEN, PHONE, {
      to: '919000000101',
      sdpOffer: OFFER,
    });
    expect(waCallId).toBe(CALL);
    expect(stub.requests).toHaveLength(2);
    stub.next(
      json(400, { error: { message: `Bad offer ${OFFER}`, code: 138007, type: 'OAuthException' } }),
    );
    const err = (await client()
      .startCall(TOKEN, PHONE, { to: '919000000101', sdpOffer: OFFER })
      .catch((e: unknown) => e)) as MetaApiError;
    expect(err.message).toBe('Bad offer <sdp>');
    expect(mapCallError(err).code).toBe('WHATSAPP_CALL_FAILED');
    expectNoSdpInLogs();
  });

  it('call analytics: daily business-initiated points per country; cost may be missing', async () => {
    stub.next(json(200, fixture('graph-call-analytics.json')));
    const start = new Date(Date.UTC(2026, 9, 22));
    const end = new Date(Date.UTC(2026, 9, 25));
    const points = await client().getCallAnalytics(TOKEN, '102290129340398', { start, end });
    expect(last()).toMatchObject({ method: 'GET', path: '/v23.0/102290129340398' });
    expect(last().query.fields).toBe(
      `call_analytics.start(${String(start.getTime() / 1000)}).end(${String(end.getTime() / 1000)}).granularity(DAILY).directions(BUSINESS_INITIATED).dimensions(COUNTRY,DIRECTION)`,
    );
    expect(points).toEqual([
      {
        start: new Date(1761264000 * 1000),
        end: new Date(1761350400 * 1000),
        direction: 'BUSINESS_INITIATED',
        country: 'IN',
        count: 35,
        cost: 0.47795,
        averageDurationSec: 106,
      },
      {
        start: new Date(1761177600 * 1000),
        end: new Date(1761264000 * 1000),
        direction: null,
        country: null,
        count: 20,
        cost: null,
        averageDurationSec: 103,
      },
    ]);
  });

  it('an answer without a call id is an invalid response', async () => {
    stub.next(json(200, { messaging_product: 'whatsapp', calls: [] }));
    await expect(
      client().startCall(TOKEN, PHONE, { to: '919000000101', sdpOffer: OFFER }),
    ).rejects.toMatchObject({ type: 'invalid_response' });
  });
});
