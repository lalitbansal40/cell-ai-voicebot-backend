import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { systemClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { ScaledClock } from '../../src/core/voice/scaled-clock';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WebhookDeliveryModel } from '../../src/db/models/webhook-delivery.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { WebhookEventModel } from '../../src/db/models/webhook-event.model';
import { generateApiKey } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { CallManager } from '../../src/modules/calls/call.service';
import { createDryRunPrograms } from '../../src/modules/calls/dry-run';
import { CallRegistry } from '../../src/modules/calls/registry';
import { processSend } from '../../src/modules/inbox/send.job';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import { deliverWebhook, webhookRuntime } from '../../src/modules/webhooks/deliver.job';
import { setWebhookJobs } from '../../src/modules/webhooks/jobs';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard, fund } from '../helpers/calls';
import { ALL_DAY } from '../helpers/campaigns';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { auth, FLOWS, saveGraph } from '../helpers/flows';
import { useInboxWorld, valueOf } from '../helpers/inbox';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp, testEnv } from '../helpers/test-app';
import { useWebhookReceiver } from '../helpers/webhook-receiver';
import { userActor } from '../helpers/whatsapp';

/**
 * PHASE_15_PLAN §0 "Done when": an outside script with only an API key creates a
 * contact, triggers a call, gets the signed `call.completed` webhook on its own
 * server and reads the same result back; then sends a template and follows
 * `whatsapp.message.status` sent → delivered → read. The signature is checked with
 * the algorithm from docs/api/webhooks.md — not with our helper.
 */
useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const receiver = useWebhookReceiver();
const storage = world.storage;
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-external-'));
const prefix = `${uniquePrefix('external')}:`;
const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const STRICT = { AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' };

let redis: Redis;
let manager: CallManager;
let app: ReturnType<typeof buildTestApp>;
let key: string;
let secret: string;
let flowId: string;
let templateName: string;

/** The receiver's check, written from the docs (raw body, 5 min window, constant time). */
const documentedVerify = (headers: Record<string, unknown>, raw: string, secrets: string[]) => {
  const ts = String(headers['x-webhook-timestamp']);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const given = String(headers['x-webhook-signature'])
    .split(',')
    .map((s) => s.trim().replace(/^v1=/, ''));
  return secrets.some((s) => {
    const expected = createHmac('sha256', s).update(`${ts}.${raw}`).digest();
    return given.some((g) => {
      const b = Buffer.from(g, 'hex');
      return b.length === expected.length && timingSafeEqual(b, expected);
    });
  });
};

const received = (type: string) =>
  receiver.received
    .map((r) => ({
      r,
      body: JSON.parse(r.raw) as { id: string; type: string; data: Record<string, unknown> },
    }))
    .filter((x) => x.body.type === type);

beforeAll(async () => {
  redis = (await requireRedis()).client;
  await ensureRateCard();
  await Promise.all([
    WebhookEndpointModel.createIndexes(),
    WebhookEventModel.createIndexes(),
    WebhookDeliveryModel.createIndexes(),
  ]);
  const env = loadEnv({ NODE_ENV: 'test', VOICE_PROVIDER: 'fake' });
  manager = new CallManager({
    logger: silent,
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    scriptFor: () => Promise.reject(new Error('web calls are not used here')),
    dryRun: createDryRunPrograms({ env, storage, redis }),
    // "Call now" plays in real time: 100× here
    clock: new ScaledClock(100, systemClock),
  });
  // the worker: deliveries run right away through the real HTTP path
  const rt = webhookRuntime(testEnv(STRICT), receiver.hooks);
  setWebhookJobs({
    enqueueDelivery: (deliveryId, attempt, _delay, replay) => {
      setImmediate(() => void deliverWebhook(rt, { deliveryId, attempt, replay }));
      return Promise.resolve();
    },
  });
  app = buildTestApp(STRICT, {
    calls: {
      manager,
      registry: new CallRegistry(redis, prefix),
      textInput: false,
      voiceProvider: 'fake',
    },
    whatsapp: {
      ctx: world.w.ctx,
      jobs: { enqueueEvent: () => Promise.resolve() },
      inboxJobs: world.jobs,
      storage,
    },
    webhooks: receiver.hooks,
  });
});

afterAll(async () => {
  await manager.shutdown();
  await flushPrefix(redis, prefix);
  rmSync(recordingDir, { recursive: true, force: true });
});

describe('an outside system with only an API key', () => {
  it('creates a contact, calls it, gets call.completed signed and reads the same result', async () => {
    const { users } = await world.setup();
    await fund(state.acc.account._id);
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      {
        'settings.callingWindow': ALL_DAY,
        'settings.callCaps': { perDay: 100, perWeek: 100, minGapMinutes: 0 },
      },
    );
    // the owner prepares a flow and a key (dashboard)
    const flow = await request(app).post(FLOWS).set(auth(users.owner)).send({ name: 'Reminder' });
    flowId = flow.body.data.id as string;
    const graph = {
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'greet',
          type: 'speak',
          label: 'Greeting',
          position: { x: 0, y: 120 },
          config: { text: 'Namaste, your EMI is due tomorrow.' },
        },
        { id: 'bye', type: 'hangup', position: { x: 0, y: 240 }, config: { text: 'Dhanyavaad.' } },
      ],
      edges: [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'greet' },
        { id: 'e2', source: 'greet', sourceHandle: 'next', target: 'bye' },
      ],
      variables: [],
    };
    const saved = await saveGraph(
      app,
      users.owner,
      flowId,
      flow.body.data.revision as number,
      graph,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const published = await request(app)
      .post(`${FLOWS}/${flowId}/publish`)
      .set(auth(users.owner))
      .send({ revision: saved.body.data.revision as number });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    key = generateApiKey(false);
    await ApiKeyModel.create({
      accountId: state.acc.account._id,
      name: 'LMS',
      prefix: key.slice(0, 13),
      keyHash: sha256Hex(key),
      scopes: [
        'contacts:write',
        'calls:write',
        'calls:read',
        'webhooks:manage',
        'messages:write',
        'messages:read',
      ],
      createdBy: users.owner.user._id,
    });

    // 1. register the webhook with the key
    const hook = await request(app)
      .post('/api/v1/webhook-endpoints')
      .set('X-API-Key', key)
      .send({
        url: receiver.url('/lms/hooks'),
        events: ['call.started', 'call.completed', 'whatsapp.message.status'],
      });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    secret = hook.body.data.secret as string;

    // 2. push a contact
    const contact = await request(app)
      .post('/api/v1/contacts?upsert=externalId')
      .set('X-API-Key', key)
      .send({ phone: '+919000880011', name: 'Asha Verma', externalId: 'LMS-77' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);

    // 3. call it
    const started = await request(app)
      .post('/api/v1/calls')
      .set('X-API-Key', key)
      .set('Idempotency-Key', randomUUID())
      .send({ contactId: contact.body.data.id, flowId, externalRef: 'loan-77' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const callId = started.body.data.id as string;

    // 4. the webhooks arrive on our server
    await vi.waitFor(
      () => {
        expect(received('call.completed')).toHaveLength(1);
      },
      { timeout: 25_000, interval: 200 },
    );
    const [startedHook] = received('call.started');
    const [done] = received('call.completed');
    expect(startedHook?.body.data.callId).toBe(callId);
    expect(documentedVerify(done?.r.headers ?? {}, done?.r.raw ?? '', [secret])).toBe(true);
    expect(documentedVerify(done?.r.headers ?? {}, `${done?.r.raw ?? ''} `, [secret])).toBe(false);
    expect(done?.r.headers['x-webhook-id']).toBe(done?.body.id);
    expect(done?.body.data).toMatchObject({
      callId,
      externalRef: 'loan-77',
      contactExternalId: 'LMS-77',
    });
    expect(done?.body.data).not.toHaveProperty('phone');

    // 5. the same result through the API
    const read = await request(app).get(`/api/v1/calls/${callId}`).set('X-API-Key', key);
    expect(read.status).toBe(200);
    const call = read.body.data as {
      status: string;
      endReason: string;
      durationSec: number;
      disposition: string | null;
      cost: { totalMicros: number };
      externalRef: string;
    };
    expect(done?.body.data).toMatchObject({
      status: call.status,
      endReason: call.endReason,
      durationSec: call.durationSec,
      disposition: call.disposition,
      costMicros: call.cost.totalMicros,
      externalRef: call.externalRef,
    });
  });

  it('sends a template and follows whatsapp.message.status: sent → delivered → read', async () => {
    templateName = `ext_${randomUUID().slice(0, 6)}_instant`;
    await createTemplate(
      { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage },
      state.acc.account._id,
      userActor(),
      {
        channelId: state.channel._id.toString(),
        name: templateName,
        language: 'en',
        category: 'UTILITY',
        components: [
          { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
        ],
      },
    );
    const sent = await request(app)
      .post('/api/v1/messages/template')
      .set('X-API-Key', key)
      .set('Idempotency-Key', randomUUID())
      .send({
        to: '+919000880011',
        template: { name: templateName, language: 'en' },
        variables: { '1': 'Asha' },
        externalRef: 'emi-reminder-77',
      });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const messageId = sent.body.data.id as string;
    // the send worker hands it to (fake) Meta
    const job = world.jobs.sent.find((j) => j.id === messageId);
    expect(job).toBeDefined();
    await processSend(state.ix, messageId, { finalAttempt: true, waits: 0 });
    const accepted = await request(app).get(`/api/v1/messages/${messageId}`).set('X-API-Key', key);
    const wamid = (await MessageModel.findById(messageId).lean())?.waMessageId ?? '';
    expect(accepted.body.data.status).toBe('accepted');
    // Meta's status webhooks
    for (const status of ['sent', 'delivered', 'read']) {
      await world.fixture('statuses-sent.json', (p) => {
        const s = (valueOf(p).statuses as Record<string, unknown>[])[0] as Record<string, unknown>;
        Object.assign(s, { id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)) });
      });
    }
    await vi.waitFor(
      () => {
        expect(received('whatsapp.message.status').map((x) => x.body.data.status)).toEqual([
          'sent',
          'delivered',
          'read',
        ]);
      },
      { timeout: 10_000, interval: 100 },
    );
    for (const x of received('whatsapp.message.status')) {
      expect(documentedVerify(x.r.headers, x.r.raw, [secret])).toBe(true);
      expect(x.body.data).toMatchObject({ messageId, externalRef: 'emi-reminder-77' });
    }
    const final = await request(app).get(`/api/v1/messages/${messageId}`).set('X-API-Key', key);
    expect(final.body.data.status).toBe('read');
  });
});
