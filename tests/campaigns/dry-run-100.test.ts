import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import {
  CampaignContactModel,
  FINAL_CONTACT_STATUSES,
  type CampaignContactDoc,
} from '../../src/db/models/campaign-contact.model';
import type { CampaignDoc } from '../../src/db/models/campaign.model';
import { setCampaignHooks, startCampaign } from '../../src/modules/campaigns/campaigns.service';
import { contactCounts } from '../../src/modules/campaigns/snapshot';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard } from '../helpers/calls';
import { campaignWorld, type CampaignWorld } from '../helpers/campaigns';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

/**
 * The 100-contact dry run (PHASE_8_PROMPT T8.8 §1): ×50, every outcome, 3
 * attempts, 15-minute retries and a short daily window, so the run waits
 * overnight more than once. It runs once (beforeAll); each `it` checks one
 * property of the result.
 */
useTestDb();
useCapturedEmail();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-dry100-'));
const prefix = `${uniquePrefix('dry100')}:`;
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

const IST = 'Asia/Kolkata';
/** 09:00–09:15 every day; with the 5-minute end buffer dials start 09:00–09:10. */
const WINDOW = { start: '09:00', end: '09:15', days: [0, 1, 2, 3, 4, 5, 6] };
const localMinutes = (at: number) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(at)
    .split(':')
    .map(Number) as [number, number];
  return h * 60 + m;
};
const localDay = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(at);

let server: Server;
let redis: Redis;
let w: CampaignWorld;
let id: string;
let campaign: CampaignDoc;
let rows: CampaignContactDoc[];
let calls: CallDoc[];
const dials: { cc: string; attempt: number; at: number }[] = [];
let maxLive = 0;
let finished = false;

beforeAll(async () => {
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  extraPorts.push(port);
  redis = (await requireRedis()).client;
  await ensureRateCard();
  // tomorrow 09:00 IST: the fake clock always runs ahead of real time
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const start = new Date(`${localDay(tomorrow.getTime())}T09:00:00+05:30`).getTime();
  w = await campaignWorld(
    { app, port, redis, prefix, storage, recordingDir, logger, phonePrefix: '90007' },
    { clockStart: start, maxConcurrentCalls: 20, manualTicks: true },
  );
  id = await w.campaign({
    audience: { listIds: [await w.listOf(100)], excludeActiveCampaigns: false },
    window: WINDOW,
    retry: { maxAttempts: 3, intervalMinutes: 15, retryOn: ['no_answer', 'busy', 'failed'] },
    pacing: { concurrency: 20, dialsPerMinute: 60 },
    dryRun: {
      speed: 50,
      mix: { answered: 6_000, no_answer: 2_000, busy: 1_000, failed: 500, invalid_number: 500 },
    },
  });
  const real = w.calls.startOutboundCall.bind(w.calls);
  vi.spyOn(w.calls, 'startOutboundCall').mockImplementation(async (input) => {
    dials.push({
      cc: input.campaign?.campaignContactId ?? '',
      attempt: input.campaign?.attempt ?? 0,
      at: w.clock.now(),
    });
    return real(input);
  });
  await startCampaign(w.req, id);
  const live = () =>
    CallModel.countDocuments({
      campaignId: id,
      status: { $in: ['queued', 'ringing', 'in_progress'] },
    });
  finished = await w.drive(async () => (await w.docOf(id)).status === 'completed', {
    rounds: 4_000,
    stepMs: 15_000,
    each: async () => {
      const now = await live();
      maxLive = Math.max(maxLive, now);
      // window closed and nothing live: jump to the next morning
      const doc = await w.docOf(id);
      if (now === 0 && doc.waitingUntil && doc.waitingUntil.getTime() > w.clock.now()) {
        w.clock.advance(doc.waitingUntil.getTime() - w.clock.now());
      }
    },
  });
  campaign = await w.docOf(id);
  rows = await CampaignContactModel.find({ campaignId: id }).lean<CampaignContactDoc[]>();
  calls = await CallModel.find({ campaignId: id }).lean<CallDoc[]>();
});
afterAll(async () => {
  setCampaignHooks({});
  await w.shutdown();
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
  await new Promise<void>((done) => server.close(() => done()));
});

describe('100-contact dry run at ×50 with an overnight window gap', () => {
  it('completes with every contact final', () => {
    expect(finished).toBe(true);
    expect(campaign.status).toBe('completed');
    expect(rows).toHaveLength(100);
    expect(
      rows.every((r) => (FINAL_CONTACT_STATUSES as readonly string[]).includes(r.status)),
    ).toBe(true);
  });

  it('stats equal a recount from the contacts', async () => {
    const counts = await contactCounts(campaign._id);
    expect(campaign.stats).toMatchObject({
      total: 100,
      pending: 0,
      queued: 0,
      calling: 0,
      waiting: 0,
      completed: counts.byStat.completed,
      failed: counts.byStat.failed,
      skipped: counts.byStat.skipped,
      attempts: calls.length,
    });
    expect(campaign.stats.completed + campaign.stats.failed + campaign.stats.skipped).toBe(100);
  });

  it('retries stop at 3 attempts; one call per attempt, never two', () => {
    expect(rows.every((r) => r.attempts >= 1)).toBe(true);
    // retries stop at 3 attempts; a customer's callback / promise follow-up may add calls
    for (const c of calls.filter((x) => (x.attempt ?? 0) > 3)) {
      const before = calls.find(
        (x) =>
          String(x.campaignContactId) === String(c.campaignContactId) &&
          x.attempt === (c.attempt ?? 0) - 1,
      );
      expect(['callback_requested', 'promise_to_pay']).toContain(before?.disposition);
    }
    const keys = calls.map((c) => `${String(c.campaignContactId)}:${String(c.attempt)}`);
    expect(new Set(keys).size).toBe(calls.length);
    for (const r of rows) {
      expect(calls.filter((c) => String(c.campaignContactId) === r._id.toString())).toHaveLength(
        r.attempts,
      );
    }
    expect(rows.some((r) => r.attempts > 1)).toBe(true); // retries happened
    expect(maxLive).toBeLessThanOrEqual(20);
  });

  it('dials only inside the window, over more than one day', () => {
    expect(dials).toHaveLength(calls.length);
    for (const d of dials) {
      const m = localMinutes(d.at);
      expect(m).toBeGreaterThanOrEqual(9 * 60);
      expect(m).toBeLessThanOrEqual(9 * 60 + 10); // ≥ 5 min before 09:15 (minute precision)
    }
    expect(new Set(dials.map((d) => localDay(d.at))).size).toBeGreaterThan(1);
    // a retry never goes out before interval ÷ speed (15 min ÷ 50 = 18 s) after its attempt
    for (const d of dials.filter((x) => x.attempt > 1)) {
      const previous = dials.find((x) => x.cc === d.cc && x.attempt === d.attempt - 1);
      expect(d.at - (previous?.at ?? 0)).toBeGreaterThanOrEqual(18_000);
    }
  });

  it('dispositions add up; the virtual cost is the sum of the calls; nothing was charged', () => {
    // one per answered call with an outcome (a contact may have several: callback, then paid)
    const dispositions = Object.values(campaign.stats.dispositions).reduce((a, b) => a + b, 0);
    expect(dispositions).toBe(calls.filter((c) => c.disposition).length);
    expect(campaign.stats.answered).toBe(calls.filter((c) => c.timestamps.answeredAt).length);
    const costs = calls.reduce((sum, c) => sum + c.cost.totalMicros, 0);
    expect(campaign.stats.virtualCostMicros).toBe(costs);
    expect(rows.reduce((sum, r) => sum + r.costMicros, 0)).toBe(costs);
    expect(campaign.stats.spentMicros).toBe(0);
    expect(calls.every((c) => !c.charged && c.provider === 'dryrun')).toBe(true);
    // every outcome showed up
    expect(new Set(calls.map((c) => c.status))).toEqual(
      new Set(['completed', 'no_answer', 'busy', 'failed']),
    );
    expect(rows.some((r) => r.skipReason === 'invalid_phone')).toBe(true);
  });
});
