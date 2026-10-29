import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { WEBHOOK_LIMITS } from '../../src/config/limits';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WebhookDeliveryModel } from '../../src/db/models/webhook-delivery.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { WebhookEventModel } from '../../src/db/models/webhook-event.model';
import { withTransaction } from '../../src/db/transaction';
import {
  checkWebhookHealth,
  deliverWebhook,
  webhookRuntime,
  type WebhookRuntime,
} from '../../src/modules/webhooks/deliver.job';
import { emitAccountEvent, fanOut, withoutPersonalData } from '../../src/modules/webhooks/events';
import { recordingWebhookJobs, setWebhookJobs } from '../../src/modules/webhooks/jobs';
import { verify } from '../../src/modules/webhooks/signing';
import * as logger from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { lastEmail, useCapturedEmail } from '../helpers/email';
import { buildTestApp, testEnv } from '../helpers/test-app';
import { useWebhookReceiver } from '../helpers/webhook-receiver';

useTestDb();
const emails = useCapturedEmail();
const receiver = useWebhookReceiver();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Like production: private / local addresses refused (the receiver is reached through `dial`). */
const STRICT = testEnv({ AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' });
let clock = new Date('2026-10-29T10:00:00.000Z');
const rt = (): WebhookRuntime =>
  webhookRuntime(STRICT, { ...receiver.hooks, now: () => clock, timeoutMs: 1_000 });
const app = () =>
  buildTestApp(
    { AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' },
    { webhooks: { ...receiver.hooks, now: () => clock } },
  );
let jobs = recordingWebhookJobs();

let a: TestAccount;
let owner: TestUser;

beforeAll(async () => {
  await Promise.all([
    WebhookEndpointModel.createIndexes(),
    WebhookDeliveryModel.createIndexes(),
    WebhookEventModel.createIndexes(),
  ]);
});

beforeEach(async () => {
  clock = new Date('2026-10-29T10:00:00.000Z');
  jobs = recordingWebhookJobs();
  setWebhookJobs(jobs);
  receiver.reset();
  a = await createTestAccount();
  owner = await a.addUser('owner');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const addEndpoint = async (body: Record<string, unknown> = {}) => {
  const res = await request(app())
    .post('/api/v1/webhook-endpoints')
    .set(bearer(owner.token))
    .send({ url: receiver.url(), events: ['*'], ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { endpoint: { id: string }; secret: string };
};

/** Runs every queued delivery job (like the worker), including the retries it schedules. */
const drain = async (maxRounds = 10) => {
  for (let i = 0; i < maxRounds && jobs.queued.length; i += 1) {
    const batch = jobs.queued.splice(0);
    for (const j of batch) {
      await deliverWebhook(rt(), {
        deliveryId: j.deliveryId,
        attempt: j.attempt,
        replay: j.replay,
      });
    }
  }
};

const data = { callId: 'c1', status: 'completed', phone: '+919876543210', name: 'Asha' };

describe('emitAccountEvent → delivery', () => {
  it('posts the signed payload once per matching endpoint; the receiver can verify it', async () => {
    const { secret, endpoint } = await addEndpoint();
    const other = await addEndpoint({ events: ['whatsapp.message.status'] });
    const eventId = await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    expect(eventId).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(jobs.queued).toHaveLength(1);
    await drain();
    expect(receiver.received).toHaveLength(1);
    const got = receiver.received[0];
    expect(got?.headers['user-agent']).toBe('NotifyNow-Webhooks/1.0');
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers['x-webhook-id']).toBe(eventId);
    const ts = Number(got?.headers['x-webhook-timestamp']);
    expect(ts).toBe(Math.floor(clock.getTime() / 1000));
    expect(
      verify(String(got?.headers['x-webhook-signature']), [secret], ts, got?.raw ?? '', {
        now: clock.getTime(),
      }),
    ).toBe(true);
    expect(JSON.parse(got?.raw ?? '{}')).toEqual({
      id: eventId,
      type: 'call.completed',
      apiVersion: '2026-10',
      createdAt: clock.toISOString(),
      accountId: a.account._id.toString(),
      data: { callId: 'c1', status: 'completed' },
    });
    const d = await WebhookDeliveryModel.findOne({ endpointId: endpoint.id }).lean();
    expect(d).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      responseStatus: 200,
      responseSnippet: 'ok',
    });
    expect(await WebhookDeliveryModel.countDocuments({ endpointId: other.endpoint.id })).toBe(0);
    // a second fan-out of the same event never makes a second delivery
    expect(await fanOut(eventId ?? '', a.account._id, 'call.completed')).toBe(0);
  });

  it('sends personal fields only to endpoints that opted in', async () => {
    await addEndpoint({ includePersonalData: true });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    await drain();
    expect(JSON.parse(receiver.received[0]?.raw ?? '{}').data).toEqual(data);
    expect(
      withoutPersonalData({
        a: 1,
        phone: 'p',
        nested: { name: 'n', ok: true },
        list: [1],
        at: clock,
      }),
    ).toEqual({ a: 1, nested: { ok: true }, list: [1], at: clock });
  });

  it('writes the outbox inside the caller transaction and fans out only after commit', async () => {
    await addEndpoint();
    await withTransaction(async (session) => {
      await emitAccountEvent(a.account._id, 'call.started', { callId: 'x' }, { session });
      expect(jobs.queued).toHaveLength(0);
    });
    await vi.waitFor(() => {
      expect(jobs.queued).toHaveLength(1);
    });
    jobs.queued.length = 0;
    await expect(
      withTransaction(async (session) => {
        await emitAccountEvent(a.account._id, 'call.started', { callId: 'y' }, { session });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs.queued).toHaveLength(0);
    expect(await WebhookEventModel.countDocuments({ 'data.callId': 'y' })).toBe(0);
  });

  it('never throws into the caller (logs, returns null)', async () => {
    vi.spyOn(WebhookEventModel, 'create').mockRejectedValueOnce(new Error('db down'));
    await expect(emitAccountEvent(a.account._id, 'call.started', {})).resolves.toBeNull();
  });
});

describe('retries', () => {
  it('retries at 1 m, 5 m, 30 m, 2 h, 12 h, then gives the event up', async () => {
    const { endpoint } = await addEndpoint();
    receiver.reply({ status: 500, body: 'boom' });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const [job] = jobs.queued.splice(0);
      expect(job?.attempt).toBe(attempt);
      if (attempt > 1) delays.push(job?.delayMs ?? 0);
      clock = new Date(clock.getTime() + (job?.delayMs ?? 0));
      await deliverWebhook(rt(), { deliveryId: job?.deliveryId ?? '', attempt });
    }
    expect(delays).toEqual(WEBHOOK_LIMITS.retryDelaysSec.map((s) => s * 1000));
    expect(jobs.queued).toHaveLength(0);
    const d = await WebhookDeliveryModel.findOne({ endpointId: endpoint.id }).lean();
    expect(d).toMatchObject({
      status: 'gave_up',
      attempt: 6,
      responseStatus: 500,
      error: 'http_500',
    });
    expect(d?.attempts).toHaveLength(6);
    expect(new Set(receiver.received.map((r) => r.headers['x-webhook-id'])).size).toBe(1);
    const e = await WebhookEndpointModel.findById(endpoint.id).lean();
    expect(e).toMatchObject({ failureStreak: 1, active: true, lastDeliveryStatus: 'failed' });
  });

  it('a pending delivery shows the next attempt; a duplicate job of the same attempt does nothing', async () => {
    await addEndpoint();
    receiver.reply({ status: 503 });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    const [job] = jobs.queued.splice(0);
    await deliverWebhook(rt(), { deliveryId: job?.deliveryId ?? '', attempt: 1 });
    expect(await deliverWebhook(rt(), { deliveryId: job?.deliveryId ?? '', attempt: 1 })).toEqual({
      status: 'duplicate',
    });
    const d = await WebhookDeliveryModel.findById(job?.deliveryId).lean();
    expect(d?.status).toBe('pending');
    expect(d?.nextAttemptAt?.getTime()).toBe(clock.getTime() + 60_000);
    expect(receiver.received).toHaveLength(1);
  });

  it('disables the endpoint after 5 events given up in a row: notification, e-mail, audit', async () => {
    const { endpoint } = await addEndpoint({ description: 'CRM' });
    receiver.reply({ status: 500 });
    for (let i = 0; i < WEBHOOK_LIMITS.disableAfterGivenUp; i += 1) {
      await emitAccountEvent(
        a.account._id,
        'call.completed',
        { callId: `c${String(i)}` },
        { at: clock },
      );
      await drain();
    }
    const e = await WebhookEndpointModel.findById(endpoint.id).lean();
    expect(e).toMatchObject({ active: false, disabledReason: 'failing', failureStreak: 5 });
    expect(
      await NotificationModel.countDocuments({
        accountId: a.account._id,
        type: 'webhook.endpoint_disabled',
      }),
    ).toBeGreaterThan(0);
    const mail = lastEmail(emails, 'webhooks.endpoint_disabled', owner.user.email);
    expect(mail?.vars).toMatchObject({
      host: `hooks.example.com:${String(receiver.port)}`,
      description: 'CRM',
    });
    expect(JSON.stringify(mail)).not.toContain('/hook');
    const audit = await AuditLogModel.findOne({
      action: 'webhook_endpoint.disabled',
      'target.id': endpoint.id,
    }).lean();
    expect(audit?.actor.type).toBe('system');
    expect(audit?.meta).toMatchObject({ reason: 'failing', givenUp: 5 });
    // new events skip a disabled endpoint
    jobs.queued.length = 0;
    await emitAccountEvent(a.account._id, 'call.completed', { callId: 'after' }, { at: clock });
    expect(jobs.queued).toHaveLength(0);
  });

  it('a success resets the streak', async () => {
    const { endpoint } = await addEndpoint();
    receiver.reply({ status: 500 });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    await drain();
    receiver.reply({ status: 204 });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    await drain();
    expect(await WebhookEndpointModel.findById(endpoint.id).lean()).toMatchObject({
      failureStreak: 0,
      failingSince: null,
      lastDeliveryStatus: 'succeeded',
    });
  });

  it('turns off endpoints failing for 24 hours (webhook-health)', async () => {
    const { endpoint } = await addEndpoint();
    receiver.reply({ status: 500 });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    const [job] = jobs.queued.splice(0);
    await deliverWebhook(rt(), { deliveryId: job?.deliveryId ?? '', attempt: 1 });
    await checkWebhookHealth(rt());
    expect((await WebhookEndpointModel.findById(endpoint.id).lean())?.active).toBe(true);
    clock = new Date(clock.getTime() + 24 * 3_600_000 + 1);
    expect((await checkWebhookHealth(rt())).disabled).toBeGreaterThanOrEqual(1);
    expect((await WebhookEndpointModel.findById(endpoint.id).lean())?.active).toBe(false);
    // a pending retry to a disabled endpoint stops
    const [next] = jobs.queued.splice(0);
    expect(await deliverWebhook(rt(), { deliveryId: next?.deliveryId ?? '', attempt: 2 })).toEqual({
      status: 'failed',
    });
  });
});

describe('transport', () => {
  it.each([
    [
      'a redirect (never followed)',
      { status: 302, headers: { location: 'http://10.0.0.1/' } },
      'redirect',
    ],
    ['a timeout', { status: 200, hang: true }, 'timeout'],
    ['a 404', { status: 404 }, 'http_404'],
  ])('records %s as a failure', async (_n, reply, error) => {
    await addEndpoint();
    receiver.reply(reply);
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    const [job] = jobs.queued.splice(0);
    await deliverWebhook(rt(), { deliveryId: job?.deliveryId ?? '', attempt: 1 });
    expect((await WebhookDeliveryModel.findById(job?.deliveryId).lean())?.error).toBe(error);
  });

  it('keeps only the first 1 KB of a text answer and drops binary answers', async () => {
    await addEndpoint();
    receiver.reply({ status: 200, body: 'y'.repeat(5_000) });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    await drain();
    const d = await WebhookDeliveryModel.findOne({ accountId: a.account._id }).lean();
    expect(d?.responseSnippet).toHaveLength(WEBHOOK_LIMITS.responseSnippetBytes);
    receiver.reply({ status: 200, body: 'PNG', headers: { 'content-type': 'image/png' } });
    await emitAccountEvent(a.account._id, 'call.started', data, { at: clock });
    await drain();
    const png = await WebhookDeliveryModel.findOne({
      accountId: a.account._id,
      type: 'call.started',
    }).lean();
    expect(png?.responseSnippet).toBeNull();
  });

  it('re-checks DNS at delivery (a host that now points inside is blocked)', async () => {
    await addEndpoint();
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    const [job] = jobs.queued.splice(0);
    const rebound = webhookRuntime(STRICT, {
      resolve: () => Promise.resolve(['10.0.0.5']),
      now: () => clock,
    });
    await deliverWebhook(rebound, { deliveryId: job?.deliveryId ?? '', attempt: 1 });
    expect((await WebhookDeliveryModel.findById(job?.deliveryId).lean())?.error).toBe('blocked');
    expect(receiver.received).toHaveLength(0);
  });

  it('refuses payloads over 64 KB', async () => {
    await addEndpoint();
    await emitAccountEvent(
      a.account._id,
      'call.completed',
      { blob: 'x'.repeat(70 * 1024) },
      { at: clock },
    );
    await drain();
    expect((await WebhookDeliveryModel.findOne({ accountId: a.account._id }).lean())?.error).toBe(
      'too_large',
    );
    expect(receiver.received).toHaveLength(0);
  });

  it('logs ids and statuses only — never payloads, secrets or answers', async () => {
    const lines: unknown[] = [];
    const log = logger.getLogger();
    vi.spyOn(log, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    const { secret } = await addEndpoint({ includePersonalData: true });
    receiver.reply({ status: 200, body: 'receiver-secret-answer' });
    await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    await drain();
    const text = JSON.stringify(lines);
    expect(text).toContain('webhooks: delivery attempt');
    for (const bad of ['+919876543210', 'Asha', secret, 'receiver-secret-answer', 'v1=']) {
      expect(text).not.toContain(bad);
    }
  });
});

describe('replay and rotation', () => {
  it('replays a given-up delivery with the same event id (one attempt)', async () => {
    await addEndpoint();
    receiver.reply({ status: 500 });
    const eventId = await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
    await drain();
    const d = await WebhookDeliveryModel.findOne({ accountId: a.account._id }).lean();
    expect(d?.status).toBe('gave_up');
    receiver.reset();
    const res = await request(app())
      .post(`/api/v1/webhook-deliveries/${String(d?._id)}/replay`)
      .set(bearer(owner.token));
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('pending');
    expect(jobs.queued).toEqual([
      { deliveryId: d?._id.toString(), attempt: 7, delayMs: 0, replay: true },
    ]);
    await drain();
    expect(receiver.received[0]?.headers['x-webhook-id']).toBe(eventId);
    expect((await WebhookDeliveryModel.findById(d?._id).lean())?.status).toBe('succeeded');
    // a scheduled delivery can't be replayed twice at once
    await WebhookDeliveryModel.updateOne({ _id: d?._id }, { $set: { status: 'pending' } });
    expect(
      (
        await request(app())
          .post(`/api/v1/webhook-deliveries/${String(d?._id)}/replay`)
          .set(bearer(owner.token))
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app())
          .post(`/api/v1/webhook-deliveries/${new Types.ObjectId().toString()}/replay`)
          .set(bearer(owner.token))
      ).status,
    ).toBe(404);
  });

  it('signs with both secrets for 24 h after a rotation, then only the new one', async () => {
    const { endpoint, secret: old } = await addEndpoint();
    const rotated = await request(app())
      .post(`/api/v1/webhook-endpoints/${endpoint.id}/rotate-secret`)
      .set(bearer(owner.token));
    expect(rotated.status).toBe(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    const fresh = rotated.body.data.secret as string;
    expect(fresh).not.toBe(old);
    const send = async () => {
      receiver.reset();
      await emitAccountEvent(a.account._id, 'call.completed', data, { at: clock });
      await drain();
      const got = receiver.received[0];
      const ts = Number(got?.headers['x-webhook-timestamp']);
      const sig = String(got?.headers['x-webhook-signature']);
      return {
        old: verify(sig, [old], ts, got?.raw ?? '', { now: clock.getTime() }),
        fresh: verify(sig, [fresh], ts, got?.raw ?? '', { now: clock.getTime() }),
        parts: sig.split(', ').length,
      };
    };
    expect(await send()).toEqual({ old: true, fresh: true, parts: 2 });
    clock = new Date(clock.getTime() + 24 * 3_600_000 + 1_000);
    expect(await send()).toEqual({ old: false, fresh: true, parts: 1 });
    const audit = await AuditLogModel.findOne({ action: 'webhook_endpoint.secret_rotated' }).lean();
    expect(JSON.stringify(audit)).not.toContain(fresh);
  });
});
