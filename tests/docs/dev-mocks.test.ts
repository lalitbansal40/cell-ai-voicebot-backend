import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import {
  clearReceipts,
  DEV_RECEIVER_KEEP,
  DEV_RECEIVER_PATH,
} from '../../src/modules/mock-apis/webhook-receiver';
import { newWebhookSecret, signatureHeader } from '../../src/modules/webhooks/signing';
import { seal, secretBoxKey } from '../../src/shared/crypto/secret-box';
import { useTestDb } from '../helpers/db';
import { PRODUCTION_APP_ENV } from '../helpers/production-env';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const env = loadEnv();

const body = JSON.stringify({
  id: 'evt_01JBTESTTESTTESTTESTTESTTE',
  type: 'call.completed',
  data: { callId: 'c1', phone: '+919876543210' },
});

const post = (headers: Record<string, string>, raw = body) =>
  request(app)
    .post(DEV_RECEIVER_PATH)
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(raw);

const signed = (secret: string, raw = body, ts = Math.floor(Date.now() / 1000)) => ({
  'X-Webhook-Id': 'evt_01JBTESTTESTTESTTESTTESTTE',
  'X-Webhook-Timestamp': String(ts),
  'X-Webhook-Signature': signatureHeader([secret], ts, raw),
});

beforeEach(async () => {
  clearReceipts();
  await WebhookEndpointModel.deleteMany({});
});

describe('dev mocks (T15.8)', () => {
  it('POST /mock/payment-link returns a made-up link valid for a day', async () => {
    const res = await request(app)
      .post('/api/v1/mock/payment-link')
      .send({ loanId: 'LN 1001', amount: 2500 });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://pay.example.com/l/LN%201001?amount=2500');
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect((await request(app).post('/api/v1/mock/payment-link').send({})).status).toBe(422);
  });

  it('GET /mock/dev-receiver gives the address the webhook form offers', async () => {
    const res = await request(app).get('/api/v1/mock/dev-receiver');
    expect(res.body).toEqual({
      url: `http://127.0.0.1:${String(env.PORT)}${DEV_RECEIVER_PATH}`,
    });
  });

  it('the receiver checks the signature against endpoints pointing at it', async () => {
    const secret = newWebhookSecret();
    const previous = newWebhookSecret();
    const key = secretBoxKey(env);
    await WebhookEndpointModel.create({
      accountId: new Types.ObjectId(),
      url: `http://127.0.0.1:5100${DEV_RECEIVER_PATH}`,
      secretSealed: seal(key, secret),
      secretPreviousSealed: seal(key, previous),
      rotatedAt: new Date(),
    });
    // an endpoint elsewhere never counts
    await WebhookEndpointModel.create({
      accountId: new Types.ObjectId(),
      url: 'https://crm.example.com/hook',
      secretSealed: seal(key, 'whsec_other'),
    });

    const ok = await post(signed(secret));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      eventId: 'evt_01JBTESTTESTTESTTESTTESTTE',
      type: 'call.completed',
      verified: true,
      bytes: Buffer.byteLength(body),
    });
    expect((await post(signed(previous))).body.verified).toBe(true); // rotation overlap
    expect((await post(signed('whsec_other'))).body.verified).toBe(false);
    expect((await post(signed(secret), `${body} `)).body.verified).toBe(false); // other bytes
    const sig = signed(secret);
    expect((await post(sig, `${body}`.replace('c1', 'c2'))).body.verified).toBe(false);
    expect(
      (await post(signed(secret, body, Math.floor(Date.now() / 1000) - 3600))).body.verified,
    ).toBe(false); // outside the 5-minute window
    expect((await post({}, 'not json')).body).toMatchObject({ verified: false, type: null });

    const list = await request(app).get(DEV_RECEIVER_PATH);
    expect(list.body).toHaveLength(7);
    expect(list.body[6]).toMatchObject({ verified: true, type: 'call.completed' });
    // the receiver keeps no payloads
    expect(JSON.stringify(list.body)).not.toContain('+919876543210');
  });

  it('keeps only the last 50 receipts', async () => {
    for (let i = 0; i < DEV_RECEIVER_KEEP + 3; i += 1) await post({}, `{"type":"t${String(i)}"}`);
    const list = await request(app).get(DEV_RECEIVER_PATH);
    expect(list.body).toHaveLength(DEV_RECEIVER_KEEP);
    expect(list.body[0].type).toBe(`t${String(DEV_RECEIVER_KEEP + 2)}`);
  });

  it('are not mounted when disabled or in production (404)', async () => {
    const off = buildTestApp({ MOCK_APIS_ENABLED: 'false' });
    const prod = buildTestApp(PRODUCTION_APP_ENV);
    for (const target of [off, prod]) {
      expect((await request(target).get('/api/v1/mock/dev-receiver')).status).toBe(404);
      expect((await request(target).get(DEV_RECEIVER_PATH)).status).toBe(404);
      expect(
        (await request(target).post('/api/v1/mock/payment-link').send({ loanId: 'L', amount: 1 }))
          .status,
      ).toBe(404);
    }
  });
});
