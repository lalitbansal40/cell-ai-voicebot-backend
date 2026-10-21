import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import {
  CampaignContactModel,
  FINAL_CONTACT_STATUSES,
} from '../../src/db/models/campaign-contact.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import {
  cancelCampaign,
  setCampaignHooks,
  startCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { processCampaignJob } from '../../src/modules/campaigns/jobs';
import { contactCounts } from '../../src/modules/campaigns/snapshot';
import { sweepCampaigns } from '../../src/modules/campaigns/sweep';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard } from '../helpers/calls';
import { campaignWorld, type CampaignWorld, type CampaignWorldDeps } from '../helpers/campaigns';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { FLOWS, auth } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-harden-'));
const prefix = `${uniquePrefix('harden')}:`;
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    storage,
    aiProvider: createFakeProvider(),
    aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);

let server: Server;
let redis: Redis;
let deps: CampaignWorldDeps;
const worlds: CampaignWorld[] = [];

beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  redis = (await requireRedis()).client;
  await ensureRateCard();
  deps = { app, port, redis, prefix, storage, recordingDir, logger, phonePrefix: '90008' };
});
afterEach(() => setCampaignHooks({}));
afterAll(async () => {
  for (const w of worlds) await w.shutdown();
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((done) => server.close(() => done()));
});

const world = async (opts: Parameters<typeof campaignWorld>[1] = {}) => {
  const w = await campaignWorld(deps, opts);
  worlds.push(w);
  return w;
};
const ALL_PAID = {
  speed: 50,
  mix: { answered: 10_000, no_answer: 0, busy: 0, failed: 0, invalid_number: 0 },
  scenarios: {
    paid: 100,
    promise: 0,
    refuse: 0,
    callback: 0,
    silence: 0,
    wrong_number: 0,
    hangup_early: 0,
    wrong_keys: 0,
  },
};
const live = (id: string) =>
  CallModel.countDocuments({
    campaignId: id,
    status: { $in: ['queued', 'ringing', 'in_progress'] },
  });
const noDoubleDial = async (id: string) => {
  const calls = await CallModel.find({ campaignId: id }).lean<CallDoc[]>();
  const keys = calls.map((c) => `${String(c.campaignContactId)}:${String(c.attempt)}`);
  expect(new Set(keys).size).toBe(calls.length);
  const rows = await CampaignContactModel.find({ campaignId: id }).lean();
  for (const r of rows) {
    // every dial is a call numbered 1…dials; a killed call is not counted in `attempts`
    const own = calls
      .filter((c) => String(c.campaignContactId) === r._id.toString())
      .map((c) => c.attempt)
      .sort();
    expect(own).toEqual(Array.from({ length: r.dials }, (_, i) => i + 1));
    expect(r.attempts).toBeLessThanOrEqual(r.dials);
  }
};
const finalAndCounted = async (w: CampaignWorld, id: string, total: number) => {
  const doc = await w.docOf(id);
  expect(doc.status).toBe('completed');
  const rows = await CampaignContactModel.find({ campaignId: id }).lean();
  expect(rows).toHaveLength(total);
  expect(rows.every((r) => (FINAL_CONTACT_STATUSES as readonly string[]).includes(r.status))).toBe(
    true,
  );
  const counts = await contactCounts(doc._id);
  expect(doc.stats).toMatchObject({
    total,
    completed: counts.byStat.completed,
    failed: counts.byStat.failed,
    pending: 0,
    calling: 0,
    queued: 0,
    waiting: 0,
  });
};

describe('restart safety (PHASE_8_PLAN §1k)', () => {
  it('a crashed process (dispatcher stopped, live calls killed, results lost) → a new one + sweep finish with the same totals', async () => {
    const w = await world({ maxConcurrentCalls: 6 });
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(12)], excludeActiveCampaigns: false },
      pacing: { concurrency: 6 },
      dryRun: { ...ALL_PAID, speed: 5 },
    });
    await startCampaign(w.req, id);
    expect(await w.drive(async () => (await live(id)) >= 3)).toBe(true);
    // the crash: no more ticks, the results of the calls being killed are lost
    await w.dispatcher.stop();
    vi.spyOn(w.dispatcher, 'callEnded').mockResolvedValue(undefined);
    await w.calls.shutdown();
    const stranded = await CampaignContactModel.countDocuments({
      campaignId: id,
      status: 'calling',
    });
    expect(stranded).toBeGreaterThanOrEqual(3);
    // a new process: its sweep applies the lost results (not counted) and releases claims
    const next = w.process();
    const later = new Date(Date.now() + 10 * 60_000);
    const swept = await sweepCampaigns({ dispatcher: next.dispatcher, logger, now: later });
    expect(swept.applied).toBeGreaterThanOrEqual(3);
    expect(
      await CampaignContactModel.countDocuments({
        campaignId: id,
        status: { $in: ['calling', 'queued'] },
      }),
    ).toBe(0);
    await CampaignModel.updateOne({ _id: id }, { 'dryRun.speed': 50 });
    // the lost calls come back due at the sweep's time
    w.clock.advance(Math.max(0, later.getTime() - w.clock.now()));
    const accountId = w.accountId;
    let done = false;
    for (let i = 0; i < 600 && !done; i += 1) {
      w.clock.advance(Math.max(0, Date.now() - w.clock.now()) + 1_000);
      await next.dispatcher.tick(accountId);
      await new Promise((r) => setTimeout(r, 25));
      done = (await w.docOf(id)).status === 'completed';
    }
    expect(done).toBe(true);
    await finalAndCounted(w, id, 12);
    await noDoubleDial(id);
    // killed calls ended as server_shutdown and were not counted as attempts
    const killed = await CallModel.countDocuments({ campaignId: id, endReason: 'server_shutdown' });
    expect(killed).toBeGreaterThanOrEqual(3);
    await next.dispatcher.stop();
    await next.calls.shutdown();
  });

  it('a Redis flush mid-run (slots, rate buckets, registry) → the run still completes without double dials', async () => {
    const w = await world({ maxConcurrentCalls: 4 });
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(10)], excludeActiveCampaigns: false },
      pacing: { concurrency: 4 },
      dryRun: ALL_PAID,
    });
    await startCampaign(w.req, id);
    expect(await w.drive(async () => (await live(id)) >= 2)).toBe(true);
    await flushPrefix(redis, prefix);
    // the minute sweep keeps the loops alive and recounts
    await sweepCampaigns({ dispatcher: w.dispatcher, logger });
    expect(await w.drive(async () => (await w.docOf(id)).status === 'completed')).toBe(true);
    await finalAndCounted(w, id, 10);
    await noDoubleDial(id);
  });

  it('BullMQ retries of start / end / run jobs change nothing the second and third time', async () => {
    const w = await world();
    const later = await w.campaign({
      audience: { listIds: [await w.listOf(2)], excludeActiveCampaigns: false },
      schedule: { startAt: new Date(Date.now() + 3600_000).toISOString() },
      dryRun: ALL_PAID,
    });
    await startCampaign(w.req, later);
    await CampaignModel.updateOne(
      { _id: later },
      { 'schedule.startAt': new Date(Date.now() - 1000) },
    );
    const run = processCampaignJob({ dispatcher: w.dispatcher, logger });
    const job = (name: string, data: object) => ({ name, data }) as unknown as Job;
    for (let i = 0; i < 3; i += 1) await run(job('campaign.start', { campaignId: later }));
    const started = await w.docOf(later);
    expect(started.status).toBe('running');
    expect(started.history.filter((h) => h.status === 'running')).toHaveLength(1);
    expect(await CampaignContactModel.countDocuments({ campaignId: later })).toBe(2);
    for (let i = 0; i < 3; i += 1) await run(job('campaign.end', { campaignId: later }));
    const ended = await w.docOf(later);
    expect(ended.status).toBe('completed');
    expect(ended.history.filter((h) => h.status === 'completed')).toHaveLength(1);
    const parent = await w.campaign({
      audience: { listIds: [await w.listOf(1)], excludeActiveCampaigns: false },
      schedule: { recurrence: { freq: 'daily', days: [], time: '10:00', until: null } },
      dryRun: ALL_PAID,
    });
    await startCampaign(w.req, parent);
    await CampaignModel.updateOne({ _id: parent }, { nextRunAt: new Date(Date.now() - 1000) });
    for (let i = 0; i < 3; i += 1) await run(job('campaign.run', { campaignId: parent }));
    expect(await CampaignModel.countDocuments({ parentId: parent })).toBe(1);
  });
});

describe('two processes on one Redis + Mongo', () => {
  it('account slots hold across both dispatchers; no contact is claimed twice', async () => {
    const w = await world({ maxConcurrentCalls: 3 });
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(12)], excludeActiveCampaigns: false },
      pacing: { concurrency: 3 },
      dryRun: ALL_PAID,
    });
    await startCampaign(w.req, id);
    const second = w.process();
    let maxLive = 0;
    let done = false;
    for (let i = 0; i < 600 && !done; i += 1) {
      w.clock.advance(Math.max(0, Date.now() - w.clock.now()));
      // both "processes" tick at the same time
      await Promise.all([w.dispatcher.tick(w.accountId), second.dispatcher.tick(w.accountId)]);
      maxLive = Math.max(maxLive, await live(id));
      await new Promise((r) => setTimeout(r, 25));
      done = (await w.docOf(id)).status === 'completed';
    }
    expect(done).toBe(true);
    expect(maxLive).toBeLessThanOrEqual(3);
    await finalAndCounted(w, id, 12);
    await noDoubleDial(id);
    const byProcess = await CallModel.aggregate([
      { $match: { campaignId: (await w.docOf(id))._id } },
      { $group: { _id: null, n: { $sum: 1 } } },
    ]);
    expect(byProcess[0]?.n).toBe(12);
    await second.dispatcher.stop();
    await second.calls.shutdown();
  });
});

describe('failure paths', () => {
  it('the AI agent switched off mid-run: the campaign pauses (flow_not_runnable), live calls finish', async () => {
    const w = await world({ maxConcurrentCalls: 5 });
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(14)], excludeActiveCampaigns: false },
      pacing: { concurrency: 5 },
      dryRun: { ...ALL_PAID, speed: 5 },
    });
    await startCampaign(w.req, id);
    expect(await w.drive(async () => (await live(id)) >= 1)).toBe(true);
    await AiAgentModel.updateOne({ _id: w.agentId }, { isActive: false });
    // the check runs every 30 s (dispatcher clock)
    expect(
      await w.drive(async () => (await w.docOf(id)).status === 'paused', { stepMs: 31_000 }),
    ).toBe(true);
    expect((await w.docOf(id)).pauseReason).toBe('flow_not_runnable');
    const dialed = await CallModel.countDocuments({ campaignId: id });
    expect(dialed).toBeLessThan(14);
    expect(await w.drive(async () => (await live(id)) === 0)).toBe(true);
    expect(await CallModel.countDocuments({ campaignId: id })).toBe(dialed);
  });

  it('a flow archived mid-run keeps running on its pinned version', async () => {
    const w = await world({ maxConcurrentCalls: 4 });
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(6)], excludeActiveCampaigns: false },
      pacing: { concurrency: 2 },
      dryRun: ALL_PAID,
    });
    await startCampaign(w.req, id);
    expect(await w.drive(async () => (await live(id)) >= 1)).toBe(true);
    const archived = await request(app)
      .post(`${FLOWS}/${w.flowId}/archive`)
      .set(auth(w.owner))
      .send({ archived: true });
    expect([200, 201]).toContain(archived.status);
    expect(await w.drive(async () => (await w.docOf(id)).status === 'completed')).toBe(true);
    await finalAndCounted(w, id, 6);
  });

  it('cancel without hang-up: waiting contacts are canceled, live calls finish normally', async () => {
    const w = await world({ maxConcurrentCalls: 4 });
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(8)], excludeActiveCampaigns: false },
      pacing: { concurrency: 2 },
      dryRun: { ...ALL_PAID, speed: 5 },
    });
    await startCampaign(w.req, id);
    expect(await w.drive(async () => (await live(id)) >= 1)).toBe(true);
    await cancelCampaign(w.req, id, false);
    const doc = await w.docOf(id);
    expect(doc.status).toBe('canceled');
    expect(await CampaignContactModel.countDocuments({ campaignId: id, status: 'canceled' })).toBe(
      8 -
        (await CampaignContactModel.countDocuments({
          campaignId: id,
          status: { $ne: 'canceled' },
        })),
    );
    expect(await w.drive(async () => (await live(id)) === 0)).toBe(true);
    const ended = await CallModel.find({ campaignId: id }).lean();
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(ended.every((c) => c.endReason !== 'campaign_canceled')).toBe(true);
    // no new dials after the cancel
    const before = ended.length;
    await w.drive(() => Promise.resolve(false), { rounds: 5 });
    expect(await CallModel.countDocuments({ campaignId: id })).toBe(before);
  });
});
