import { Writable } from 'node:stream';

import type { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { createQueue } from '../../src/core/queues/queue-factory';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { queueWhatsAppJobs, type WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import {
  eventKey,
  stableStringify,
  verifyChallenge,
} from '../../src/modules/whatsapp/webhooks.service';
import { createLogger, setLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';
import { useWhatsAppWorld, webhookFor } from '../helpers/whatsapp';

useTestDb();
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

const enqueued: string[] = [];
let jobsDown = false;
const memoryJobs: WhatsAppJobs = {
  enqueueEvent: (id) => {
    if (jobsDown) return Promise.reject(new Error('redis down'));
    enqueued.push(id);
    return Promise.resolve();
  },
};
const app = () => buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs: memoryJobs } });

const channel = {
  wabaId: '555000111',
  phoneNumberId: '555000222',
  displayPhoneNumber: '+91 90000 77777',
};
const post = (
  body: Buffer | string,
  signature: string | null = signWebhook(body, w.env.FAKE_META_APP_SECRET ?? ''),
  target = app(),
) => {
  const req = request(target).post('/api/v1/webhooks/meta').set('content-type', 'application/json');
  if (signature) req.set('x-hub-signature-256', signature);
  return req.send(body);
};
const payload = (fixture = 'webhook-messages-text.json') =>
  JSON.stringify(webhookFor(fixture, channel));

beforeEach(() => {
  enqueued.length = 0;
  jobsDown = false;
});

describe('GET /webhooks/meta (verification)', () => {
  const get = (q: Record<string, string | undefined>) =>
    request(app()).get('/api/v1/webhooks/meta').query(q);

  it('echoes the challenge for the right token only', async () => {
    const ok = await get({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'dev-meta-verify-token',
      'hub.challenge': '1158201444',
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    for (const q of [
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
      {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'dev-meta-verify-token',
        'hub.challenge': '1',
      },
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'dev-meta-verify-token' },
      {},
    ]) {
      expect((await get(q)).status).toBe(403);
    }
  });

  it('refuses when no verify token is configured', () => {
    expect(
      verifyChallenge(
        { env: { ...w.env, META_WEBHOOK_VERIFY_TOKEN: '' } },
        { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' },
      ),
    ).toBeNull();
  });
});

describe('POST /webhooks/meta', () => {
  it('signature table → 401 META_SIGNATURE_INVALID', async () => {
    const body = payload();
    const good = signWebhook(body, w.env.FAKE_META_APP_SECRET ?? '');
    const tampered = body.replace('Test hello', 'Test hellO');
    for (const [raw, sig] of [
      [body, null],
      [tampered, good],
      [body, good.replace('sha256=', 'sha1=')],
      [body, signWebhook(body, 'another-secret')],
    ] as const) {
      const res = await post(raw, sig);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('META_SIGNATURE_INVALID');
    }
    expect(await MetaWebhookEventModel.countDocuments({ wabaId: channel.wabaId })).toBe(0);
  });

  it('bodies over 3 MB → 413; not JSON / not a webhook → 422; other objects ignored', async () => {
    const big = JSON.stringify({
      object: 'whatsapp_business_account',
      pad: 'x'.repeat(3 * 1024 * 1024),
    });
    expect((await post(big)).status).toBe(413);
    expect((await post('not json')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await post(JSON.stringify({ object: 5 }))).status).toBe(422);
    const page = await post(JSON.stringify({ object: 'page', entry: [] }));
    expect(page.status).toBe(200);
    expect(page.body.data).toEqual({ received: 0, duplicates: 0, ignored: true });
    // a form body never reaches the raw parser → empty body → bad signature
    const form = await request(app()).post('/api/v1/webhooks/meta').type('form').send({ a: '1' });
    expect(form.status).toBe(401);
  });

  it('stores every change once (sealed) and queues it', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: channel.wabaId,
          changes: [
            ...(
              webhookFor('webhook-messages-text.json', channel).entry as { changes: unknown[] }[]
            )[0]!.changes,
            ...(
              webhookFor('webhook-account-update-ban.json', channel).entry as {
                changes: unknown[];
              }[]
            )[0]!.changes,
          ],
        },
      ],
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: 2, duplicates: 0, ignored: false });
    const events = await MetaWebhookEventModel.find({ wabaId: channel.wabaId })
      .select('+payloadSealed')
      .lean();
    expect(events.map((e) => e.field).sort()).toEqual(['account_update', 'messages']);
    const messages = events.find((e) => e.field === 'messages');
    expect(messages).toMatchObject({
      phoneNumberId: channel.phoneNumberId,
      status: 'received',
      attempts: 0,
    });
    expect(messages?.payloadSealed).toMatch(/^v1:/);
    expect(messages?.payloadSealed).not.toContain('Test hello');
    expect(events.find((e) => e.field === 'account_update')?.phoneNumberId).toBeNull();
    expect(messages!.expiresAt.getTime() - messages!.receivedAt.getTime()).toBe(7 * 86_400_000);
    expect(enqueued.sort()).toEqual(events.map((e) => e._id.toString()).sort());
    expect(logLines.join('')).not.toContain('Test hello');
  });

  it('the same delivery twice → one event, one job (real queue)', async () => {
    const queue: Queue = createQueue('whatsapp', {
      redisUrl: w.env.REDIS_URL,
      logger: createLogger(w.env),
      prefix: uniquePrefix('waq'),
    });
    const target = buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs: queueWhatsAppJobs(queue) } });
    const body = payload('webhook-quality-update.json');
    expect((await post(body, undefined, target)).body.data).toMatchObject({ received: 1 });
    expect((await post(body, undefined, target)).body.data).toMatchObject({
      received: 0,
      duplicates: 1,
    });
    expect(
      await MetaWebhookEventModel.countDocuments({
        field: 'phone_number_quality_update',
        wabaId: channel.wabaId,
      }),
    ).toBe(1);
    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('queue down → 503; Meta retries after recovery → stored once and queued', async () => {
    jobsDown = true;
    const body = payload('webhook-name-update.json');
    const down = await post(body);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(
      await MetaWebhookEventModel.countDocuments({
        field: 'phone_number_name_update',
        wabaId: channel.wabaId,
      }),
    ).toBe(1);
    jobsDown = false;
    const retry = await post(body);
    expect(retry.body.data).toMatchObject({ received: 0, duplicates: 1 });
    expect(enqueued).toHaveLength(1);
    // once processed, a redelivery is not queued again
    await MetaWebhookEventModel.updateOne({ _id: enqueued[0] }, { $set: { status: 'processed' } });
    await post(body);
    expect(enqueued).toHaveLength(1);
  });

  it('404 when WhatsApp is disabled', async () => {
    const off = buildTestApp(
      { WHATSAPP_ENABLED: 'false' },
      {
        whatsapp: {
          ctx: { ...w.ctx, env: { ...w.env, WHATSAPP_ENABLED: false } },
          jobs: memoryJobs,
        },
      },
    );
    expect((await request(off).get('/api/v1/webhooks/meta')).status).toBe(404);
    expect((await post(payload(), undefined, off)).status).toBe(404);
    expect((await request(buildTestApp()).get('/api/v1/webhooks/meta')).status).toBe(404);
  });
});

describe('idempotency keys', () => {
  it('ignore key order, keep value differences', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: null }], u: undefined })).toBe(
      '{"a":[{"c":null,"d":2}],"b":1}',
    );
    expect(stableStringify(undefined)).toBe('null');
    const k = eventKey('o', 'e', 'f', { a: 1, b: 2 });
    expect(eventKey('o', 'e', 'f', { b: 2, a: 1 })).toBe(k);
    expect(eventKey('o', 'e', 'f', { a: 1, b: 3 })).not.toBe(k);
    expect(eventKey('o', 'e2', 'f', { a: 1, b: 2 })).not.toBe(k);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});
