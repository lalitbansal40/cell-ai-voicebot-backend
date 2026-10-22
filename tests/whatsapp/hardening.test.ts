import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { createQueue } from '../../src/core/queues/queue-factory';
import { startWhatsAppWorker } from '../../src/core/queues/workers/whatsapp.worker';
import { MIGRATIONS } from '../../src/db/migrations';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { queueWhatsAppJobs, type WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import { buildSimulatorPayload } from '../../src/modules/whatsapp/simulator';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import type { AppError } from '../../src/shared/errors/app-error';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';
import { codeFor, fakeSignup, userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let acc: TestAccount;
beforeEach(async () => {
  acc = await createTestAccount();
  await acc.addUser('owner');
  await acc.addUser('admin');
});

const connect = async () => {
  const r = await w.svc.connect({
    accountId: acc.account._id,
    actor: userActor(),
    mode: 'cloud_api',
    code: codeFor(fakeSignup()),
  });
  const channel = await WhatsAppChannelModel.findById(r.channel.id).lean();
  if (!channel) throw new Error('no channel');
  return channel;
};
/** `count` distinct inbound messages in one Meta delivery (one entry, many changes). */
const delivery = (channel: Parameters<typeof buildSimulatorPayload>[1], count: number) => {
  const changes = Array.from({ length: count }, () => {
    const p = buildSimulatorPayload('inbound_text', channel);
    return (p.entry as { changes: unknown[] }[])[0]!.changes[0];
  });
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: channel.wabaId, time: 1, changes }],
  });
};

describe('hardening', () => {
  it('1,000 signed events in 10 concurrent POSTs: stored once, processed, resends add nothing', async () => {
    const channel = await connect();
    const queued: string[] = [];
    const jobs: WhatsAppJobs = { enqueueEvent: (id) => (queued.push(id), Promise.resolve()) };
    const app = buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs } });
    const bodies = Array.from({ length: 10 }, () => delivery(channel, 100));
    const post = (body: string) =>
      request(app)
        .post('/api/v1/webhooks/meta')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', signWebhook(body, w.env.FAKE_META_APP_SECRET ?? ''))
        .send(body);
    const started = Date.now();
    const results = await Promise.all(bodies.map(post));
    const storeMs = Date.now() - started;
    expect(results.every((r) => r.status === 200 && r.body.data.received === 100)).toBe(true);
    expect(
      await MetaWebhookEventModel.countDocuments({ channelId: null, wabaId: channel.wabaId }),
    ).toBe(1000);
    expect(new Set(queued).size).toBe(1000);
    // processed with the worker's concurrency (10)
    const pending = [...queued];
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let id = pending.shift(); id; id = pending.shift()) {
          await processWebhookEvent({ ctx: w.ctx, service: w.svc }, id, { finalAttempt: false });
        }
      }),
    );
    expect(
      await MetaWebhookEventModel.countDocuments({ channelId: channel._id, status: 'deferred' }),
    ).toBe(1000);
    // Meta resends everything: no new rows, nothing queued (already processed)
    queued.length = 0;
    const resent = await Promise.all(bodies.map(post));
    expect(resent.every((r) => r.body.data.duplicates === 100)).toBe(true);
    expect(queued).toHaveLength(0);
    expect(await MetaWebhookEventModel.countDocuments({ wabaId: channel.wabaId })).toBe(1000);
    // generous bound: a laptop stores 1,000 events well under it
    expect(storeMs).toBeLessThan(60_000);
  });

  it('a worker stopped mid-batch and restarted loses nothing and repeats no effect', async () => {
    const channel = await connect();
    const prefix = uniquePrefix('wa-hard');
    const deps = { redisUrl: w.env.REDIS_URL, logger: createLogger(w.env), prefix, ctx: w.ctx };
    const queue = createQueue('whatsapp', deps);
    const jobs = queueWhatsAppJobs(queue);
    const app = buildTestApp({}, { whatsapp: { ctx: w.ctx, jobs } });
    const post = (body: string) =>
      request(app)
        .post('/api/v1/webhooks/meta')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', signWebhook(body, w.env.FAKE_META_APP_SECRET ?? ''))
        .send(body);
    await post(delivery(channel, 200));
    await post(JSON.stringify(buildSimulatorPayload('name_approved', channel)));
    const first = await startWhatsAppWorker(deps);
    // stop after some work (graceful: the running jobs finish, the rest stays queued)
    for (let i = 0; i < 200; i += 1) {
      if ((await MetaWebhookEventModel.countDocuments({ channelId: channel._id })) >= 20) break;
      await sleep(10);
    }
    await first.worker.close();
    const done = await MetaWebhookEventModel.countDocuments({ channelId: channel._id });
    expect(done).toBeLessThan(201);
    const second = await startWhatsAppWorker(deps);
    for (let i = 0; i < 1000; i += 1) {
      const left = await MetaWebhookEventModel.countDocuments({
        wabaId: channel.wabaId,
        status: 'received',
      });
      if (left === 0) break;
      await sleep(20);
    }
    await second.worker.close();
    expect(
      await MetaWebhookEventModel.countDocuments({ wabaId: channel.wabaId, status: 'received' }),
    ).toBe(0);
    expect(await MetaWebhookEventModel.countDocuments({ wabaId: channel.wabaId })).toBe(201);
    expect(
      await NotificationModel.countDocuments({
        accountId: acc.account._id,
        type: 'whatsapp.name_approved',
      }),
    ).toBe(2); // owner + admin, exactly once
    expect(
      await MetaWebhookEventModel.find({ wabaId: channel.wabaId }).distinct('attempts'),
    ).toEqual([1]);
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('the same signup code sent twice in parallel → one channel, the other refused', async () => {
    const signup = fakeSignup();
    const code = codeFor(signup);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        w.svc.connect({ accountId: acc.account._id, actor: userActor(), mode: 'cloud_api', code }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected?.reason as AppError).code).toBe('WHATSAPP_SIGNUP_FAILED');
    expect(await WhatsAppChannelModel.countDocuments({ accountId: acc.account._id })).toBe(1);
  });

  it('migration 0010 down refuses with live numbers; after a disconnect down / up keep working', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db');
    const migration = MIGRATIONS.find((m) => m.name === '0010-whatsapp');
    if (!migration) throw new Error('missing');
    await WhatsAppChannelModel.updateMany({}, { $set: { status: 'disconnected' } });
    const channel = await connect();
    await expect(migration.down(db)).rejects.toThrow('refusing to roll back');
    await w.svc.disconnect(acc.account._id, channel._id.toString(), userActor());
    await migration.down(db);
    await migration.up(db);
    await WhatsAppChannelModel.createIndexes();
    expect(await WhatsAppChannelModel.countDocuments()).toBe(0);
    expect((await connect()).status).toBe('connected');
  });
});
