import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { Queue } from 'bullmq';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { createFakeProvider } from '../../src/core/ai';
import { FakeClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { createDryRunPrograms } from '../../src/modules/calls/dry-run';
import { CallRegistry } from '../../src/modules/calls/registry';
import {
  cancelCampaign,
  createCampaign,
  setCampaignHooks,
  startCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { CampaignDispatcher, applyResult, moveStats } from '../../src/modules/campaigns/dispatcher';
import {
  autoResume,
  endJobId,
  pauseAccountCampaigns,
  processCampaignJob,
  queueCampaignJobs,
  resumeBlocker,
  startJobId,
  wireCampaigns,
} from '../../src/modules/campaigns/jobs';
import { resetProgressThrottle } from '../../src/modules/campaigns/progress';
import { DialRate } from '../../src/modules/campaigns/slots';
import { contactCounts } from '../../src/modules/campaigns/snapshot';
import { sweepCampaigns } from '../../src/modules/campaigns/sweep';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard, fund } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-dispatch-'));
const prefix = `${uniquePrefix('dispatch')}:`;
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    storage,
    aiProvider: createFakeProvider(),
    aiHttp: { extraPorts, resolve: () => Promise.resolve(['127.0.0.1']) },
  },
);
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

let server: Server;
let redis: Redis;
let calls: CallManager;
let flowId: string;
let agentId: string;
let phoneN = 0;

beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  redis = (await requireRedis()).client;
  await ensureRateCard();
  const base = `http://127.0.0.1:${String(port)}`;
  const t = await createTestAccount({ name: 'Flow Owner' });
  const owner = await t.addUser('owner');
  void t;
  const env = loadEnv({ MOCK_APIS_ENABLED: 'true', APP_URL: base, VOICE_PROVIDER: 'fake' });
  calls = new CallManager({
    logger,
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    scriptFor: () => Promise.reject(new Error('no web calls here')),
    dryRun: createDryRunPrograms({ env, storage, redis }),
  });
  void owner;
});
afterAll(async () => {
  await calls.shutdown();
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((done) => server.close(() => done()));
});
afterEach(() => {
  setCampaignHooks({});
  resetProgressThrottle();
});

const reqOf = (account: TestAccount, user: TestUser): Request =>
  ({
    auth: {
      kind: 'user',
      accountId: account.account._id.toString(),
      userId: user.user._id.toString(),
      permissions: new Set<string>(),
      account: {
        id: account.account._id.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  }) as unknown as Request;

interface World {
  t: TestAccount;
  owner: TestUser;
  req: Request;
  clock: FakeClock;
  dispatcher: CampaignDispatcher;
  listOf: (n: number, over?: Record<string, unknown>) => Promise<string>;
  campaign: (over?: Record<string, unknown>) => Promise<string>;
}

/** One account with a published Loan recovery flow, a dispatcher on a fake clock. */
const world = async (walletMicros = 2_000_000_000): Promise<World> => {
  const t = await createTestAccount();
  const owner = await t.addUser('owner');
  const req = reqOf(t, owner);
  if (walletMicros > 0) await fund(t.account._id, walletMicros);
  const all = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };
  await AccountModel.updateOne({ _id: t.account._id }, { 'settings.callingWindow': all });
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'amount',
    label: 'Amount',
    type: 'currency',
  });
  const port = (server.address() as AddressInfo).port;
  const agent = await request(app)
    .post('/api/v1/agents')
    .set(auth(owner))
    .send({ name: 'Recovery', templateKey: 'loan_recovery_hinglish' });
  agentId = agent.body.data.id;
  const mockUrl = `http://127.0.0.1:${String(port)}/api/v1/mock/payment-status?phone={{contact.phone}}`;
  await AiAgentModel.updateOne({ _id: agentId }, { $set: { 'functions.0.url': mockUrl } });
  const created = await request(app)
    .post(FLOWS)
    .set(auth(owner))
    .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
  flowId = created.body.data.id;
  const draft = created.body.data.draft;
  draft.nodes.find((n: { id: string }) => n.id === 'check').config.url = mockUrl;
  await request(app)
    .put(`${FLOWS}/${flowId}/draft`)
    .set(auth(owner))
    .send({ revision: 1, graph: draft });
  const published = await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: 2 });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  const clock = new FakeClock(Date.now());
  const dispatcher = new CampaignDispatcher({
    calls,
    rate: new DialRate(redis, `${prefix}${t.account._id.toString()}:`),
    logger,
    clock,
  });
  let n = 0;
  return {
    t,
    owner,
    req,
    clock,
    dispatcher,
    async listOf(count, over = {}) {
      const list = await ContactListModel.create({
        accountId: t.account._id,
        name: `L${String(Date.now())}${String(Math.random())}`,
        source: { type: 'manual' },
      });
      for (let i = 0; i < count; i += 1) {
        phoneN += 1;
        await ContactModel.create({
          accountId: t.account._id,
          phoneE164: `+9190008${String(phoneN).padStart(5, '0')}`,
          name: `Dial ${String(phoneN)}`,
          source: { type: 'manual' },
          listIds: [list._id],
          variables: { amount: 1_000_000_000 },
          ...over,
        });
      }
      return list._id.toString();
    },
    async campaign(over = {}) {
      n += 1;
      const c = await createCampaign(req, {
        name: `Run ${String(n)}`,
        mode: 'dry_run',
        flowId,
        window: all,
        dryRun: {
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
        },
        ...over,
      } as never);
      return c.id;
    },
  };
};

const docOf = async (id: string) =>
  (await CampaignModel.findById(id).lean<CampaignDoc>()) as CampaignDoc;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ticks the dispatcher (and lets real dry-run calls finish) until `done` or 600 rounds. */
const drive = async (w: World, done: () => Promise<boolean>, each?: () => Promise<void>) => {
  for (let i = 0; i < 600; i += 1) {
    if (await done()) return true;
    // the dispatcher's fake clock never runs behind real time (snapshots use real dates)
    const lag = Date.now() - w.clock.now();
    if (lag > 0) w.clock.advance(lag);
    await w.dispatcher.tick(w.t.account._id.toString());
    await each?.();
    await sleep(25);
  }
  return done();
};
const statusIs = (id: string, status: string) => async () => (await docOf(id)).status === status;

describe('dispatcher (dry run, real calls on virtual time)', () => {
  it('dials every contact to the end: stats equal a recount, contacts updated, attempts once each', async () => {
    const w = await world();
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(8)] },
      pacing: { concurrency: 3 },
    });
    await startCampaign(w.req, id);
    let maxLive = 0;
    const finished = await drive(w, statusIs(id, 'completed'), async () => {
      maxLive = Math.max(
        maxLive,
        await CallModel.countDocuments({
          campaignId: id,
          status: { $in: ['queued', 'ringing', 'in_progress'] },
        }),
      );
    });
    expect(finished).toBe(true);
    expect(maxLive).toBeLessThanOrEqual(3);
    const c = await docOf(id);
    const counts = await contactCounts(c._id);
    expect(c.stats).toMatchObject({
      total: 8,
      completed: counts.byStat.completed,
      failed: counts.byStat.failed,
      pending: 0,
      queued: 0,
      calling: 0,
      waiting: 0,
      answered: 8,
      attempts: 8,
    });
    expect(c.stats.virtualCostMicros).toBeGreaterThan(0);
    expect(c.stats.spentMicros).toBe(0);
    const rows = await CampaignContactModel.find({ campaignId: id }).lean();
    expect(rows.every((r) => r.attempts === 1 && r.lastResult === 'answered')).toBe(true);
    const contact = await ContactModel.findById(rows[0]?.contactId).lean();
    expect(contact).toMatchObject({ callCount: 1, lastCalledAt: expect.any(Date) });
    const callsOf = await CallModel.find({ campaignId: id }).lean();
    expect(callsOf).toHaveLength(8);
    expect(
      new Set(callsOf.map((x) => `${String(x.campaignContactId)}:${String(x.attempt)}`)).size,
    ).toBe(8);
    expect(callsOf.every((x) => x.charged === false && x.provider === 'dryrun')).toBe(true);
  });

  it('busy → retries after interval / speed (virtual), up to the max, then failed', async () => {
    const w = await world();
    // the default 30-minute gap between calls to one contact would hold the retry back
    await AccountModel.updateOne(
      { _id: w.t.account._id },
      { 'settings.callCaps': { perDay: 3, perWeek: 10, minGapMinutes: 0 } },
    );
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(2)] },
      retry: { maxAttempts: 2, intervalMinutes: 15, retryOn: ['busy'] },
      dryRun: {
        speed: 50,
        mix: { answered: 0, no_answer: 0, busy: 10_000, failed: 0, invalid_number: 0 },
      },
    });
    await startCampaign(w.req, id);
    expect(await drive(w, async () => (await docOf(id)).stats.waiting === 2)).toBe(true);
    const waiting = await CampaignContactModel.find({ campaignId: id }).lean();
    expect(
      waiting.every(
        (r) => r.status === 'retry_wait' && r.lastResult === 'busy' && r.attempts === 1,
      ),
    ).toBe(true);
    // not due yet; 15 min / ×50 = 18 s later the second attempt goes out
    await w.dispatcher.tick(w.t.account._id.toString());
    expect(await CallModel.countDocuments({ campaignId: id })).toBe(2);
    w.clock.advance(18_000);
    expect(await drive(w, statusIs(id, 'completed'))).toBe(true);
    const rows = await CampaignContactModel.find({ campaignId: id }).lean();
    expect(rows.every((r) => r.status === 'failed' && r.attempts === 2)).toBe(true);
    expect((await docOf(id)).stats).toMatchObject({ failed: 2, attempts: 4, answered: 0 });
  });

  it('outside the window: waits (waitingUntil, no calls); widened → dials', async () => {
    const w = await world();
    const today = new Date(w.clock.now()).getDay();
    const other = (today + 1) % 7;
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(1)] },
      window: { start: '00:00', end: '23:59', days: [other] },
    });
    await startCampaign(w.req, id);
    await w.dispatcher.tick(w.t.account._id.toString());
    const waiting = await docOf(id);
    expect(waiting.waitingUntil).toBeInstanceOf(Date);
    expect(await CallModel.countDocuments({ campaignId: id })).toBe(0);
    await CampaignModel.updateOne({ _id: id }, { 'window.days': [0, 1, 2, 3, 4, 5, 6] });
    expect(await drive(w, statusIs(id, 'completed'))).toBe(true);
    expect((await docOf(id)).waitingUntil).toBeNull();
  });

  /** Two campaigns at ×1 on an account with 2 slots; the first tick's calls per campaign. */
  const firstTick = async (a: string, b: string) => {
    const w = await world();
    await AccountModel.updateOne({ _id: w.t.account._id }, { 'limits.maxConcurrentCalls': 2 });
    const ids = [
      await w.campaign({
        audience: { listIds: [await w.listOf(3)] },
        pacing: { concurrency: 2, priority: a },
        dryRun: { speed: 1 },
      }),
      await w.campaign({
        audience: { listIds: [await w.listOf(3)] },
        pacing: { concurrency: 2, priority: b },
        dryRun: { speed: 1 },
      }),
    ];
    // the later-started campaign first: priority, not start order, decides
    await startCampaign(w.req, ids[1] as string);
    await startCampaign(w.req, ids[0] as string);
    w.clock.advance(Math.max(0, Date.now() - w.clock.now()));
    await w.dispatcher.tick(w.t.account._id.toString());
    const counts = [
      await CallModel.countDocuments({ campaignId: ids[0] }),
      await CallModel.countDocuments({ campaignId: ids[1] }),
    ];
    // hooks only now (their wake would race the tick above): cancel hangs the calls up
    const unwire = wireCampaigns({
      jobs: {
        schedule: () => Promise.resolve(),
        scheduleEnd: () => Promise.resolve(),
        drop: () => Promise.resolve(),
      },
      dispatcher: w.dispatcher,
      calls,
      logger,
    });
    for (const id of ids) await cancelCampaign(w.req, id, true);
    await drive(
      w,
      async () =>
        (await CallModel.countDocuments({
          campaignId: { $in: ids },
          status: { $in: ['queued', 'ringing', 'in_progress'] },
        })) === 0,
    );
    unwire();
    return counts;
  };

  it('priority: a high campaign fills the account slots before a normal one', async () => {
    expect(await firstTick('high', 'normal')).toEqual([2, 0]);
  });

  it('fairness: two campaigns of the same priority take turns', async () => {
    expect(await firstTick('normal', 'normal')).toEqual([1, 1]);
  });

  it('per-contact caps: a second campaign over the same contact waits for tomorrow', async () => {
    const w = await world();
    await AccountModel.updateOne(
      { _id: w.t.account._id },
      { 'settings.callCaps': { perDay: 1, perWeek: 5, minGapMinutes: 0 } },
    );
    const list = await w.listOf(1);
    const first = await w.campaign({ audience: { listIds: [list] } });
    await startCampaign(w.req, first);
    expect(await drive(w, statusIs(first, 'completed'))).toBe(true);
    const second = await w.campaign({
      audience: { listIds: [list], excludeActiveCampaigns: false },
    });
    await startCampaign(w.req, second);
    await w.dispatcher.tick(w.t.account._id.toString());
    const row = await CampaignContactModel.findOne({ campaignId: second }).lean();
    expect(row?.status).toBe('pending');
    expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(w.clock.now());
    expect(await CallModel.countDocuments({ campaignId: second })).toBe(0);
  });

  it('virtual wallet: runs out → paused (wallet_empty); a credit resumes it (auto-resume)', async () => {
    const w = await world(0);
    const jobs = {
      schedule: vi.fn(() => Promise.resolve()),
      scheduleEnd: vi.fn(() => Promise.resolve()),
      drop: vi.fn(() => Promise.resolve()),
    };
    const unwire = wireCampaigns({ jobs, dispatcher: w.dispatcher, calls, logger });
    const id = await w.campaign({ audience: { listIds: [await w.listOf(2)] } });
    await startCampaign(w.req, id);
    expect(await drive(w, statusIs(id, 'paused'))).toBe(true);
    expect((await docOf(id)).pauseReason).toBe('wallet_empty');
    expect(await resumeBlocker(await docOf(id))).toMatch(/would run out/);
    await fund(w.t.account._id, 2_000_000_000);
    expect(await drive(w, statusIs(id, 'running'))).toBe(true);
    expect(await drive(w, statusIs(id, 'completed'))).toBe(true);
    unwire();
  });

  it('circuit breaker: 10 technical failures in a row pause the campaign', async () => {
    const w = await world();
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(11)] },
      retry: { maxAttempts: 1, intervalMinutes: 15, retryOn: [] },
      pacing: { concurrency: 5 },
      dryRun: { mix: { answered: 0, no_answer: 0, busy: 0, failed: 10_000, invalid_number: 0 } },
    });
    await startCampaign(w.req, id);
    expect(await drive(w, statusIs(id, 'paused'))).toBe(true);
    expect(await docOf(id)).toMatchObject({ pauseReason: 'too_many_failures' });
    expect((await docOf(id)).stats.failureStreak).toBeGreaterThanOrEqual(10);
  });

  it('cancel with hang-up ends the live calls as campaign_canceled', async () => {
    const w = await world();
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(2)] },
      dryRun: { speed: 1 },
    });
    const unwire = wireCampaigns({
      jobs: {
        schedule: () => Promise.resolve(),
        scheduleEnd: () => Promise.resolve(),
        drop: () => Promise.resolve(),
      },
      dispatcher: w.dispatcher,
      calls,
      logger,
    });
    await startCampaign(w.req, id);
    await drive(
      w,
      async () =>
        (await CallModel.countDocuments({
          campaignId: id,
          status: { $in: ['ringing', 'in_progress'] },
        })) > 0,
    );
    await cancelCampaign(w.req, id, true);
    expect(
      await drive(
        w,
        async () =>
          (await CallModel.countDocuments({
            campaignId: id,
            status: { $in: ['queued', 'ringing', 'in_progress'] },
          })) === 0,
      ),
    ).toBe(true);
    const ended = await CallModel.find({ campaignId: id }).lean();
    expect(ended.every((c) => c.endReason === 'campaign_canceled')).toBe(true);
    unwire();
  });

  it('canceled while a contact was being dialed: that call is hung up too', async () => {
    const w = await world();
    const id = await w.campaign({
      audience: { listIds: [await w.listOf(1)] },
      dryRun: { speed: 1 },
    });
    await startCampaign(w.req, id);
    const real = calls.startOutboundCall.bind(calls);
    const spy = vi.spyOn(calls, 'startOutboundCall').mockImplementation(async (input) => {
      const out = await real(input);
      // the cancel (and its hang-up) happened while this dial was in flight
      await CampaignModel.updateOne({ _id: id }, { $set: { status: 'canceled' } });
      return out;
    });
    try {
      w.clock.advance(Math.max(0, Date.now() - w.clock.now()));
      await w.dispatcher.tick(w.t.account._id.toString());
    } finally {
      spy.mockRestore();
    }
    const call = await CallModel.findOne({ campaignId: id }).lean();
    for (let i = 0; i < 400; i += 1) {
      const now = await CallModel.findById(call?._id).lean();
      if (now?.endReason) break;
      await sleep(25);
    }
    expect((await CallModel.findById(call?._id).lean())?.endReason).toBe('campaign_canceled');
  });

  it('stop waits for a tick in flight; a stopped dispatcher schedules nothing', async () => {
    const w = await world();
    const id = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await startCampaign(w.req, id);
    w.clock.advance(Math.max(0, Date.now() - w.clock.now()));
    let ticked = false;
    void w.dispatcher.tick(w.t.account._id.toString()).then(() => (ticked = true));
    await w.dispatcher.stop();
    expect(ticked).toBe(true);
    w.dispatcher.wake(w.t.account._id.toString());
    w.dispatcher.ensureAccount(w.t.account._id.toString());
    expect(w.clock.pending).toBe(0);
    // the call it dialed still ends (calls are not the dispatcher's to stop)
    const live = () =>
      CallModel.countDocuments({
        campaignId: id,
        status: { $in: ['queued', 'ringing', 'in_progress'] },
      });
    for (let i = 0; i < 400 && (await live()) > 0; i += 1) await sleep(25);
    expect(await live()).toBe(0);
  });

  it('a suspended account pauses its running campaigns; endAt completes the rest', async () => {
    const w = await world();
    const running = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await startCampaign(w.req, running);
    await AccountModel.updateOne({ _id: w.t.account._id }, { status: 'suspended' });
    await w.dispatcher.tick(w.t.account._id.toString());
    expect(await docOf(running)).toMatchObject({
      status: 'paused',
      pauseReason: 'account_suspended',
    });
    await AccountModel.updateOne({ _id: w.t.account._id }, { status: 'active' });
    const ending = await w.campaign({
      audience: { listIds: [await w.listOf(2)] },
      schedule: { endAt: new Date(w.clock.now() + 60_000).toISOString() },
    });
    await startCampaign(w.req, ending);
    w.clock.advance(120_000);
    await w.dispatcher.tick(w.t.account._id.toString());
    const done = await docOf(ending);
    expect(done.status).toBe('completed');
    expect(done.stats.skippedBy.campaign_ended).toBe(2);
    expect(await pauseAccountCampaigns(w.t.account._id, 'admin')).toBe(0);
  });
});

describe('sweep, jobs and automation', () => {
  it('sweep: starts due campaigns, releases stale claims, applies missed results, recounts drift', async () => {
    const w = await world();
    const later = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await CampaignModel.updateOne(
      { _id: later },
      { status: 'scheduled', 'schedule.startAt': new Date(Date.now() - 1000) },
    );
    const run = await w.campaign({ audience: { listIds: [await w.listOf(3)] } });
    await startCampaign(w.req, run);
    const [a, b, c] = await CampaignContactModel.find({ campaignId: run }).sort({ seq: 1 }).lean();
    const old = new Date(Date.now() - 10 * 60_000);
    await CampaignContactModel.updateOne({ _id: a?._id }, { status: 'queued', claimedAt: old });
    // a call that ended while nobody listened
    const call = await CallModel.create({
      accountId: w.t.account._id,
      direction: 'outbound',
      provider: 'dryrun',
      from: 'dryrun',
      to: b?.phoneE164 ?? '',
      isTest: true,
      source: { kind: 'flow', flowId: new Types.ObjectId(flowId) },
      campaignId: new Types.ObjectId(run),
      campaignContactId: b?._id,
      attempt: 1,
      status: 'completed',
      endReason: 'hangup_node',
      disposition: 'paid',
      charged: false,
      timestamps: { queuedAt: old, answeredAt: old },
    });
    await CampaignContactModel.updateOne(
      { _id: b?._id },
      { status: 'calling', lastCallId: call._id, lastAttemptAt: old, attempts: 1 },
    );
    await CampaignContactModel.updateOne(
      { _id: c?._id },
      { status: 'calling', lastCallId: new Types.ObjectId(), lastAttemptAt: old, attempts: 1 },
    );
    await CampaignModel.updateOne({ _id: run }, { 'stats.pending': 99 }); // drift
    const result = await sweepCampaigns({ dispatcher: w.dispatcher, logger });
    expect(result).toMatchObject({ started: 1, released: 2, applied: 1, recounted: 1 });
    expect((await docOf(later)).status).toBe('running');
    const rows = await CampaignContactModel.find({ campaignId: run }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => r.status)).toEqual(['retry_wait', 'completed', 'retry_wait']);
    expect(rows[2]?.attempts).toBe(0);
    expect((await docOf(run)).stats.pending).toBe(0);
    // a second sweep finds nothing to do
    expect(await sweepCampaigns({ dispatcher: w.dispatcher, logger })).toMatchObject({
      started: 0,
      released: 0,
      applied: 0,
      recounted: 0,
    });
    // applying the same call again changes nothing
    await applyResult(call.toObject(), new Date());
  });

  it('sweep finishes an interrupted snapshot, ends past campaigns, lifts budget pauses', async () => {
    const w = await world();
    const run = await w.campaign({ audience: { listIds: [await w.listOf(2)] } });
    await startCampaign(w.req, run);
    await CampaignContactModel.deleteMany({ campaignId: run });
    await CampaignModel.updateOne(
      { _id: run },
      { 'snapshot.done': false, 'snapshot.cursor': null },
    );
    const ended = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await startCampaign(w.req, ended);
    await CampaignModel.updateOne(
      { _id: ended },
      { 'schedule.endAt': new Date(Date.now() - 1000) },
    );
    const budget = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await startCampaign(w.req, budget);
    await CampaignModel.updateOne(
      { _id: budget },
      { status: 'paused', pauseReason: 'budget_reached' },
    );
    const result = await sweepCampaigns({ dispatcher: w.dispatcher, logger });
    expect(result).toMatchObject({ snapshots: 1, ended: 1, resumed: 1 });
    expect(await CampaignContactModel.countDocuments({ campaignId: run })).toBe(2);
    expect((await docOf(ended)).status).toBe('completed');
    expect((await docOf(budget)).status).toBe('running');
  });

  it('jobs: start / end / wake / sweep; failures mark the campaign failed; the job ids', async () => {
    const w = await world();
    const wake = vi.spyOn(w.dispatcher, 'wake');
    const process = processCampaignJob({ dispatcher: w.dispatcher, logger });
    const job = (name: string, data: object) => ({ name, data }) as never;
    const id = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await CampaignModel.updateOne({ _id: id }, { status: 'scheduled' });
    await process(job('campaign.start', { campaignId: id }));
    expect((await docOf(id)).status).toBe('running');
    await process(job('campaign.end', { campaignId: id }));
    expect((await docOf(id)).status).toBe('completed');
    await process(job('campaign.end', { campaignId: new Types.ObjectId().toString() }));
    await process(job('campaign.wake', { accountId: w.t.account._id.toString() }));
    expect(wake).toHaveBeenCalled();
    await expect(process(job('campaigns.sweep', {}))).resolves.toMatchObject({ started: 0 });
    await expect(process(job('nope', {}))).rejects.toThrow('Unknown campaign job');
    // an agent turned off before the scheduled start → failed with the code
    const broken = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await CampaignModel.updateOne({ _id: broken }, { status: 'scheduled' });
    await AiAgentModel.updateOne({ _id: agentId }, { isActive: false });
    await process(job('campaign.start', { campaignId: broken }));
    expect(await docOf(broken)).toMatchObject({
      status: 'failed',
      error: { code: 'CAMPAIGN_NOT_RUNNABLE' },
    });
    await AiAgentModel.updateOne({ _id: agentId }, { isActive: true });
    expect(startJobId('x')).toBe('start-x');
    expect(endJobId('x')).toBe('end-x');
    expect(moveStats('pending', 'pending')).toEqual({});
  });

  it('queue jobs: start + end replaced at their times; recurring parents get no start job', async () => {
    const queue = {
      remove: vi.fn(() => Promise.resolve(1)),
      add: vi.fn(() => Promise.resolve({})),
    };
    const jobs = queueCampaignJobs(queue as unknown as Queue, () => 1_000);
    const c = {
      _id: new Types.ObjectId(),
      schedule: { startAt: new Date(61_000), endAt: new Date(121_000), recurrence: null },
    } as unknown as CampaignDoc;
    await jobs.schedule(c);
    expect(queue.add).toHaveBeenCalledWith(
      'campaign.start',
      { campaignId: c._id.toString() },
      expect.objectContaining({ jobId: `start-${c._id.toString()}`, delay: 60_000 }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'campaign.end',
      { campaignId: c._id.toString() },
      expect.objectContaining({ delay: 120_000 }),
    );
    queue.add.mockClear();
    await jobs.schedule({
      ...c,
      schedule: { startAt: null, endAt: null, recurrence: { freq: 'daily' } },
    } as unknown as CampaignDoc);
    expect(queue.add).not.toHaveBeenCalled();
    await jobs.drop(c);
    expect(queue.remove).toHaveBeenCalledWith(`end-${c._id.toString()}`);
  });

  it('auto-resume only for wallet pauses that the money allows; other pauses have no blocker', async () => {
    const w = await world(0);
    const id = await w.campaign({ audience: { listIds: [await w.listOf(1)] } });
    await startCampaign(w.req, id);
    await CampaignModel.updateOne({ _id: id }, { status: 'paused', pauseReason: 'wallet_empty' });
    expect(await autoResume(w.t.account._id.toString(), logger)).toBe(0);
    await CampaignModel.updateOne({ _id: id }, { pauseReason: 'manual' });
    expect(await resumeBlocker(await docOf(id))).toBeNull();
    await CampaignModel.updateOne({ _id: id }, { mode: 'live', pauseReason: 'wallet_empty' });
    expect(await resumeBlocker(await docOf(id))).toBe('Add money to resume.');
  });

  it('logs carry no phones, names or customer phrases', () => {
    const log = logLines.join('');
    expect(log).not.toMatch(/\+9190008\d{5}/);
    expect(log).not.toContain('Dial ');
    expect(log).not.toContain('haan ji payment kar diya');
  });
});
