import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { sealSecret } from '../../src/modules/whatsapp/context';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import {
  PINNACLE_SECRET_HEADER,
  pinnacleWebhookUrl,
} from '../../src/modules/whatsapp/pinnacle-webhooks.service';
import { resetManagedNumbersCache } from '../../src/modules/whatsapp/webhooks.service';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';
import { insertChannel, useWhatsAppWorld, webhookFor } from '../helpers/whatsapp';

useTestDb();
const w = useWhatsAppWorld({ PINNACLE_ENABLED: 'true' });

const enqueued: string[] = [];
const memoryJobs: WhatsAppJobs = {
  enqueueEvent: (id) => {
    enqueued.push(id);
    return Promise.resolve();
  },
};
const app = () => buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs: memoryJobs } });

let channel: WhatsAppChannelDoc;
let secret: string;

const managedChannel = async (over: Partial<WhatsAppChannelDoc> = {}) => {
  secret = randomBytes(32).toString('base64url');
  const tag = randomBytes(5).toString('hex');
  const doc = await insertChannel({
    provider: 'pinnacle',
    wabaId: `9${String(Date.now()).slice(-8)}${tag.length}`,
    phoneNumberId: `8${String(Date.now()).slice(-9)}${String(Math.floor(Math.random() * 1000))}`,
    displayPhoneNumber: '+91 90000 66666',
    pinnacle: {
      webhookSecretSealed: sealSecret(w.ctx, secret),
      webhookUrl: null,
      webhookSetAt: new Date(),
      keyLast4: 'abcd',
      keyCheckedAt: new Date(),
      lastBalanceErrorAt: null,
      addedBy: null,
    },
    ...over,
  });
  return (await WhatsAppChannelModel.findById(doc._id).lean<WhatsAppChannelDoc>())!;
};

const body = (
  target: Pick<WhatsAppChannelDoc, 'wabaId' | 'phoneNumberId' | 'displayPhoneNumber'>,
  fixture = 'webhook-messages-text.json',
) => {
  // unique per call (the idempotency key hashes the change)
  return JSON.stringify(webhookFor(fixture, target)).replace(
    /"timestamp":"(\d+)"/,
    `"timestamp":"${String(Date.now())}${randomBytes(2).readUInt16BE()}"`,
  );
};

const post = (id: string, payload: string, header: string | null = secret) => {
  const req = request(app())
    .post(`/api/v1/webhooks/pinnacle/${id}`)
    .set('content-type', 'application/json');
  if (header !== null) req.set(PINNACLE_SECRET_HEADER, header);
  return req.send(payload);
};

beforeEach(async () => {
  enqueued.length = 0;
  channel = await managedChannel();
  resetManagedNumbersCache();
});

describe('Pinnacle webhook (PN D8–D10)', () => {
  it('our URL for a channel', () => {
    expect(pinnacleWebhookUrl({ APP_URL: 'https://api.example.test/' }, channel._id)).toBe(
      `https://api.example.test/api/v1/webhooks/pinnacle/${channel._id.toString()}`,
    );
  });

  it('GET answers ok (panel ping)', async () => {
    const res = await request(app()).get(`/api/v1/webhooks/pinnacle/${channel._id.toString()}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  it('stores the relayed change with source pinnacle and queues it', async () => {
    const res = await post(channel._id.toString(), body(channel));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: 1, duplicates: 0, ignored: false });
    expect(enqueued).toHaveLength(1);
    const stored = await MetaWebhookEventModel.findById(enqueued[0]).lean();
    expect(stored).toMatchObject({
      source: 'pinnacle',
      phoneNumberId: channel.phoneNumberId,
      field: 'messages',
    });
  });

  it('wrong or missing secret → 403, nothing stored', async () => {
    const before = await MetaWebhookEventModel.countDocuments();
    expect((await post(channel._id.toString(), body(channel), 'nope')).status).toBe(403);
    const missing = await post(channel._id.toString(), body(channel), null);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('PINNACLE_WEBHOOK_FORBIDDEN');
    expect(await MetaWebhookEventModel.countDocuments()).toBe(before);
  });

  it('unknown, Meta or disconnected channels → 404', async () => {
    expect((await post('not-an-id', body(channel))).status).toBe(404);
    expect((await post('64b000000000000000000000', body(channel))).status).toBe(404);
    const meta = await insertChannel({ provider: 'fake' });
    expect((await post(meta._id.toString(), body(channel))).status).toBe(404);
    const gone = await managedChannel({ status: 'disconnected' });
    expect((await post(gone._id.toString(), body(gone))).status).toBe(404);
  });

  it('drops changes of another number, keeps its own', async () => {
    const own = JSON.parse(body(channel)) as { entry: { changes: unknown[] }[] };
    const other = JSON.parse(
      body({ wabaId: '111', phoneNumberId: '222', displayPhoneNumber: '+91 90000 11111' }),
    ) as { entry: { changes: unknown[] }[] };
    own.entry.push(...other.entry);
    const res = await post(channel._id.toString(), JSON.stringify(own));
    expect(res.body.data.received).toBe(1);
  });

  it('the same event from Meta and from the relay is stored once', async () => {
    const meta = await insertChannel({ provider: 'fake' });
    const payload = body({
      wabaId: meta.wabaId,
      phoneNumberId: meta.phoneNumberId,
      displayPhoneNumber: '+91 90000 55555',
    });
    // Meta delivers it for a Meta number …
    const viaMeta = await request(app())
      .post('/api/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signWebhook(payload, w.env.FAKE_META_APP_SECRET ?? ''))
      .send(payload);
    expect(viaMeta.body.data.received).toBe(1);
    // … and a managed number's own payload twice through the relay → stored once
    const managedPayload = body(channel);
    expect((await post(channel._id.toString(), managedPayload)).body.data.received).toBe(1);
    expect((await post(channel._id.toString(), managedPayload)).body.data).toMatchObject({
      received: 0,
      duplicates: 1,
    });
  });

  it("Meta's own delivery for a managed number is dropped (the relay brings it)", async () => {
    const payload = body(channel);
    const res = await request(app())
      .post('/api/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signWebhook(payload, w.env.FAKE_META_APP_SECRET ?? ''))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('bodies over the limit → 413; not JSON → 422', async () => {
    const big = JSON.stringify({ object: 'whatsapp_business_account', pad: 'x'.repeat(4_000_000) });
    expect((await post(channel._id.toString(), big)).status).toBe(413);
    expect((await post(channel._id.toString(), 'not json')).status).toBe(422);
  });

  it('not mounted when PINNACLE_ENABLED is off', async () => {
    const off = buildTestApp(
      {},
      {
        whatsapp: {
          ctx: { ...w.ctx, env: { ...w.ctx.env, PINNACLE_ENABLED: false } },
          jobs: memoryJobs,
        },
      },
    );
    const res = await request(off)
      .post(`/api/v1/webhooks/pinnacle/${channel._id.toString()}`)
      .set(PINNACLE_SECRET_HEADER, secret)
      .send(body(channel));
    expect(res.status).toBe(404);
  });
});
