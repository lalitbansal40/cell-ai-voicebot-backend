import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { FlowNodeStatsModel } from '../../src/db/models/flow-node-stats.model';
import { FlowVersionModel } from '../../src/db/models/flow-version.model';
import { FlowModel } from '../../src/db/models/flow.model';
import {
  StatsDailyModel,
  type StatsChannel,
  type StatsKind,
} from '../../src/db/models/stats-daily.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { ListCallsQuery } from '../../src/modules/calls/calls.schema';
import { getCall, listCalls } from '../../src/modules/calls/calls.service';
import { cachedReport } from '../../src/modules/reports/cache';
import { avg, bucketQuantile, keyed, pct } from '../../src/modules/reports/stats';
import { callDoc } from '../helpers/analytics';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();

// "today" is whatever the clock says: reports default to the last 7 days, so the tests
// pass explicit ranges and use fixed past days
const D1 = '2026-09-01';
const D2 = '2026-09-02';
const D3 = '2026-09-03';

let t: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let agent: TestUser;
let app: ReturnType<typeof buildTestApp>;
let cached: ReturnType<typeof buildTestApp>;
let redis: Redis;
const prefix = uniquePrefix('reports');
const ids = {
  campaignA: new Types.ObjectId(),
  campaignB: new Types.ObjectId(),
  goneCampaign: new Types.ObjectId(),
  flow: new Types.ObjectId(),
  agent: new Types.ObjectId(),
  template: new Types.ObjectId(),
  number: new Types.ObjectId(),
};
const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

const stat = (
  accountId: Types.ObjectId,
  day: string,
  channel: StatsChannel,
  kind: StatsKind,
  refId: Types.ObjectId | null,
  counters: Record<string, number>,
  test = false,
) => StatsDailyModel.create({ accountId, day, channel, kind, refId, counters, test });

beforeAll(async () => {
  redis = (await requireRedis()).client;
  t = await createTestAccount({ timezone: 'Asia/Kolkata' });
  owner = await t.addUser('owner');
  viewer = await t.addUser('viewer');
  agent = await t.addUser('agent');
  app = buildTestApp();
  const store = {
    get: (k: string) => redis.get(`${prefix}:${k}`),
    set: (k: string, v: string, mode: 'EX', ttl: number) =>
      redis.set(`${prefix}:${k}`, v, mode, ttl),
  };
  cached = buildTestApp({}, { reportCache: store as never });
  const a = t.account._id;
  // names
  await CampaignModel.collection.insertMany([
    { _id: ids.campaignA, accountId: a, name: 'October dues' },
    { _id: ids.campaignB, accountId: a, name: 'Late payers' },
  ]);
  await FlowModel.collection.insertOne({ _id: ids.flow, accountId: a, name: 'Loan recovery' });
  await AiAgentModel.collection.insertOne({ _id: ids.agent, accountId: a, name: 'Recovery Bot' });
  await WhatsAppTemplateModel.collection.insertOne({
    _id: ids.template,
    accountId: a,
    name: 'payment_reminder',
    language: 'en',
  });
  await WhatsAppChannelModel.collection.insertOne({
    _id: ids.number,
    accountId: a,
    label: 'Support line',
  });
  await FlowVersionModel.collection.insertOne({
    accountId: a,
    flowId: ids.flow,
    version: 1,
    graph: {
      nodes: [
        { id: 'start', type: 'start', label: 'Start' },
        { id: 'ask', type: 'ask', label: '' },
      ],
    },
  });
  await FlowNodeStatsModel.create([
    {
      accountId: a,
      flowId: ids.flow,
      version: 1,
      nodeId: 'start',
      day: D1,
      mode: 'call',
      entered: 10,
      totalMs: 20_000,
      exits: { next: 10 },
    },
    {
      accountId: a,
      flowId: ids.flow,
      version: 1,
      nodeId: 'ask',
      day: D2,
      mode: 'call',
      entered: 6,
      errorCount: 1,
      totalMs: 0,
      exits: {},
    },
    {
      accountId: a,
      flowId: ids.flow,
      version: 1,
      nodeId: 'start',
      day: D1,
      mode: 'simulator',
      entered: 99,
    },
  ]);
  // account rows
  await stat(a, D1, 'voice', 'all', null, {
    calls_attempted: 10,
    calls_answered: 6,
    calls_talk_sec: 600,
    dur_b3: 4,
    dur_b4: 2,
    outcome_promise_to_pay: 3,
    outcome_callback: 1,
    calls_no_outcome: 2,
    ptp_count: 3,
    ptp_micros: 15_000_000_000,
    sentiment_positive: 3,
    calls_outbound: 10,
    calls_ai: 10,
  });
  await stat(a, D2, 'whatsapp', 'all', null, {
    calls_attempted: 2,
    calls_answered: 1,
    calls_talk_sec: 30,
    dur_b2: 1,
    calls_human: 2,
    msg_sent: 20,
    msg_delivered: 18,
    msg_read: 9,
    msg_failed: 1,
    msg_tpl_sent: 10,
    msg_replied: 4,
    msg_inbound: 7,
    resp_count: 4,
    resp_sec: 1200,
    resp_b1: 3,
    resp_b3: 1,
  });
  await stat(a, D1, 'voice', 'all', null, { calls_attempted: 5, calls_answered: 5 }, true);
  await stat(a, D1, 'money', 'all', null, {
    spend_total: 12_000_000,
    spend_call_charge: 12_000_000,
  });
  await stat(a, D3, 'voice', 'all', null, { calls_attempted: 4 });
  // slices
  await stat(a, D1, 'voice', 'campaign', ids.campaignA, {
    calls_attempted: 8,
    calls_answered: 4,
    ptp_count: 2,
  });
  await stat(a, D1, 'money', 'campaign', ids.campaignA, { spend_total: 8_000_000 });
  await stat(a, D1, 'voice', 'campaign', ids.campaignB, { calls_attempted: 2, calls_answered: 2 });
  await stat(a, D1, 'voice', 'campaign', ids.goneCampaign, { calls_attempted: 1 });
  await stat(a, D1, 'voice', 'flow', ids.flow, { calls_attempted: 10, calls_answered: 6 });
  await stat(a, D1, 'voice', 'agent', ids.agent, { calls_attempted: 3, calls_answered: 3 });
  await stat(a, D2, 'whatsapp', 'template', ids.template, {
    msg_sent: 10,
    msg_delivered: 10,
    msg_read: 5,
    msg_replied: 4,
    msg_failed: 0,
  });
  await stat(a, D2, 'money', 'template', ids.template, { spend_total: 700_000 });
  await stat(a, D2, 'whatsapp', 'number', ids.number, {
    msg_sent: 20,
    msg_delivered: 18,
    msg_read: 9,
    msg_inbound: 7,
    calls_attempted: 2,
    calls_answered: 1,
  });
  await stat(a, D2, 'whatsapp', 'user', owner.user._id, {
    calls_answered: 1,
    calls_talk_sec: 30,
    msg_sent: 12,
    resp_count: 4,
    resp_b1: 3,
    resp_b3: 1,
  });
  // another account's numbers must never show
  const other = await createTestAccount();
  await stat(other.account._id, D1, 'voice', 'all', null, { calls_attempted: 999 });
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

const get = (tab: string, query: Record<string, string>, user = owner, server = app) =>
  request(server).get(`/api/v1/reports/${tab}`).query(query).set(auth(user));
const kpi = (
  body: { data: { kpis: { key: string; value: number | null; previous?: number | null }[] } },
  key: string,
) => body.data.kpis.find((k) => k.key === key);

describe('report helpers', () => {
  it('ratios, averages, bucket quantiles, keyed counters', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 0)).toBeNull();
    expect(pct(undefined, 4)).toBe(0);
    expect(avg(10, 3)).toBe(3);
    expect(avg(10, 0)).toBeNull();
    const c = { dur_b0: 1, dur_b2: 2, dur_b3: 1 };
    expect(bucketQuantile(c, 'dur_b', [0, 15, 30, 60], 0.5)).toBe(30);
    expect(bucketQuantile(c, 'dur_b', [0, 15, 30, 60], 0.9)).toBe(60);
    expect(bucketQuantile(c, 'dur_b', [0, 15, 30, 60], 0.1)).toBe(0);
    expect(bucketQuantile({}, 'dur_b', [0, 15], 0.5)).toBeNull();
    expect(keyed({ outcome_a: 1, outcome_b: 3, outcome_c: 0, other: 9 }, 'outcome_')).toEqual([
      ['b', 3],
      ['a', 1],
    ]);
  });
});

describe('reports API', () => {
  it('overview: account totals, day series, previous period; test calls left out', async () => {
    const res = await get('overview', { from: D1, to: D2, compare: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tab: 'overview',
      range: { from: D1, to: D2, timezone: 'Asia/Kolkata' },
      compareRange: { from: '2026-08-30', to: '2026-08-31' },
      table: { columns: [], rows: [] },
    });
    expect(kpi(res.body, 'calls_attempted')).toEqual({
      key: 'calls_attempted',
      value: 12,
      previous: 0,
      unit: 'count',
    });
    expect(kpi(res.body, 'answer_rate')?.value).toBe(58.3);
    expect(kpi(res.body, 'answer_rate')?.previous).toBeNull();
    expect(kpi(res.body, 'ptp_amount')?.value).toBe(15_000_000_000);
    expect(kpi(res.body, 'read_rate')?.value).toBe(45);
    expect(kpi(res.body, 'reply_rate')?.value).toBe(40);
    expect(kpi(res.body, 'spend')?.value).toBe(12_000_000);
    const calls = res.body.data.series.find((s: { key: string }) => s.key === 'calls_attempted');
    expect(calls.points).toEqual([
      { day: D1, value: 10 },
      { day: D2, value: 2 },
    ]);
    const withTest = await get('overview', { from: D1, to: D2, includeTest: 'true' });
    expect(kpi(withTest.body, 'calls_attempted')?.value).toBe(17);
    expect(res.headers.etag).toMatch(/^"[a-f0-9]{40}"$/);
  });

  it('calls: outcomes table (with "No outcome"), quantiles, sentiment; voice-only filter', async () => {
    const res = await get('calls', { from: D1, to: D3 });
    expect(res.body.data.table.rows).toEqual([
      { id: 'promise_to_pay', label: 'promise_to_pay', values: { calls: 3, share: 42.9 } },
      { id: 'callback', label: 'callback', values: { calls: 1, share: 14.3 } },
      { id: null, label: 'No outcome', values: { calls: 2, share: 28.6 } },
    ]);
    expect(kpi(res.body, 'median_duration')?.value).toBe(60);
    expect(kpi(res.body, 'p90_duration')?.value).toBe(120);
    expect(kpi(res.body, 'sentiment_positive')?.value).toBe(3);
    expect(kpi(res.body, 'calls_human')?.value).toBe(2);
    expect(res.body.data.series[0].points).toHaveLength(3);
    const voice = await get('calls', { from: D1, to: D3, channel: 'voice' });
    expect(kpi(voice.body, 'calls_attempted')?.value).toBe(14);
    const wa = await get('calls', { from: D1, to: D3, channel: 'whatsapp' });
    expect(kpi(wa.body, 'calls_attempted')?.value).toBe(2);
  });

  it('whatsapp: funnel KPIs, response times, a row per number', async () => {
    const res = await get('whatsapp', { from: D1, to: D2 });
    expect(kpi(res.body, 'delivered_rate')?.value).toBe(90);
    expect(kpi(res.body, 'first_response_median')?.value).toBe(60);
    expect(kpi(res.body, 'first_response_p90')?.value).toBe(900);
    expect(res.body.data.table.rows).toEqual([
      {
        id: ids.number.toString(),
        label: 'Support line',
        values: {
          messages_sent: 20,
          delivered_rate: 90,
          read_rate: 45,
          messages_failed: 0,
          messages_inbound: 7,
          calls_attempted: 2,
          calls_answered: 1,
        },
      },
    ]);
  });

  it('templates, campaigns (top 10 or chosen), agents, team — names, deleted ones labelled', async () => {
    const templates = await get('templates', { from: D1, to: D2 });
    expect(templates.body.data.table.rows[0]).toMatchObject({
      label: 'payment_reminder (en)',
      values: { messages_sent: 10, reply_rate: 40, spend: 700_000 },
    });
    const campaigns = await get('campaigns', { from: D1, to: D2 });
    expect(campaigns.body.data.table.rows.map((r: { label: string }) => r.label)).toEqual([
      'October dues',
      'Late payers',
      'Deleted campaign',
    ]);
    expect(campaigns.body.data.table.rows[0].values).toMatchObject({
      calls_attempted: 8,
      answer_rate: 50,
      ptp_count: 2,
      spend: 8_000_000,
      cost_per_answered: 2_000_000,
    });
    const chosen = await get('campaigns', {
      from: D1,
      to: D2,
      campaignIds: ids.campaignB.toString(),
    });
    expect(chosen.body.data.table.rows.map((r: { id: string }) => r.id)).toEqual([
      ids.campaignB.toString(),
    ]);
    expect((await get('agents', { from: D1, to: D2 })).body.data.table.rows[0]).toMatchObject({
      label: 'Recovery Bot',
    });
    const team = await get('team', { from: D1, to: D2 });
    expect(team.body.data.table.rows[0]).toMatchObject({
      id: owner.user._id.toString(),
      label: owner.user.name,
      values: { calls_answered: 1, messages_sent: 12, first_response_median: 60 },
    });
  });

  it('flows: a row per flow; one flow → its call funnel (simulator runs left out) with node labels', async () => {
    const list = await get('flows', { from: D1, to: D2 });
    expect(list.body.data.table.rows[0]).toMatchObject({
      label: 'Loan recovery',
      values: { calls_attempted: 10 },
    });
    const funnel = await get('flows', { from: D1, to: D2, flowId: ids.flow.toString() });
    expect(funnel.body.data.table.rows).toEqual([
      { id: 'start', label: 'Start', values: { entered: 10, errors: 0, avg_time: 2 } },
      { id: 'ask', label: 'ask', values: { entered: 6, errors: 1, avg_time: null } },
    ]);
    expect(kpi(funnel.body, 'calls_attempted')?.value).toBe(10);
  });

  it('filters: one slice at a time, range limits, defaults to the last 7 days', async () => {
    const two = await get('overview', {
      campaignId: ids.campaignA.toString(),
      flowId: ids.flow.toString(),
    });
    expect([two.status, two.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    const long = await get('overview', { from: '2025-01-01', to: '2026-09-01' });
    expect([long.status, long.body.error.code]).toEqual([422, 'REPORT_RANGE_INVALID']);
    const backwards = await get('overview', { from: D2, to: D1 });
    expect(backwards.body.error.code).toBe('REPORT_RANGE_INVALID');
    const defaults = await get('overview', {});
    expect(defaults.body.data.series[0].points).toHaveLength(7);
    expect((await get('nope', {})).status).toBe(422);
    const slice = await get('overview', { from: D1, to: D2, campaignId: ids.campaignA.toString() });
    expect(kpi(slice.body, 'calls_attempted')?.value).toBe(8);
    expect(kpi(slice.body, 'spend')?.value).toBe(8_000_000);
  });

  it('viewers can read, agents cannot; other accounts see only their own numbers', async () => {
    expect((await get('overview', { from: D1, to: D2 }, viewer)).status).toBe(200);
    expect((await get('overview', { from: D1, to: D2 }, agent)).status).toBe(403);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect(
      kpi((await get('overview', { from: D1, to: D2 }, stranger)).body, 'calls_attempted')?.value,
    ).toBe(0);
  });

  it('cache: 60 s, keyed by the resolved filters; ETag → 304; Redis trouble never breaks a report', async () => {
    const first = await get('calls', { from: D1, to: D1 }, owner, cached);
    await StatsDailyModel.updateOne(
      { accountId: t.account._id, day: D1, channel: 'voice', kind: 'all', test: false },
      { $inc: { 'counters.calls_attempted': 1 } },
    );
    const second = await get('calls', { from: D1, to: D1 }, owner, cached);
    expect(kpi(second.body, 'calls_attempted')?.value).toBe(
      kpi(first.body, 'calls_attempted')?.value,
    );
    expect(kpi((await get('calls', { from: D1, to: D1 })).body, 'calls_attempted')?.value).toBe(11);
    const etag = first.headers.etag as string;
    const notModified = await request(cached)
      .get('/api/v1/reports/calls')
      .query({ from: D1, to: D1 })
      .set({ ...auth(owner), 'if-none-match': etag });
    expect(notModified.status).toBe(304);
    await StatsDailyModel.updateOne(
      { accountId: t.account._id, day: D1, channel: 'voice', kind: 'all', test: false },
      { $inc: { 'counters.calls_attempted': -1 } },
    );
    const broken = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    };
    expect(await cachedReport(broken as never, 'k', () => Promise.resolve({ ok: 1 }))).toBe(
      '{"ok":1}',
    );
    const stuck = {
      get: () => new Promise(() => undefined),
      set: () => new Promise(() => undefined),
    };
    expect(await cachedReport(stuck as never, 'k', () => Promise.resolve({ ok: 2 }))).toBe(
      '{"ok":2}',
    );
  });
});

describe('calls list — record filters (Phase 14)', () => {
  it('filters by outcome, sentiment, promise, summary, answered by, number; the view carries the insight state', async () => {
    const a = t.account._id;
    const base = {
      insights: null,
      dispositionSource: null,
      provider: 'webcall',
      variables: {},
      outcome: {},
      metrics: emptyCallMetrics(),
      cost: emptyCallCost(),
      recording: null,
      flowRunId: null,
      error: null,
      languageDetected: null,
    };
    const state = (over: Record<string, unknown>) => ({
      status: 'done',
      reason: null,
      version: 1,
      sentiment: 'neutral',
      hasPromise: false,
      promiseAmountMicros: null,
      hasSummary: true,
      at: new Date(),
      ...over,
    });
    const promise = callDoc(a, {
      ...base,
      disposition: 'promise_to_pay',
      dispositionSource: 'ai',
      insights: state({ sentiment: 'positive', hasPromise: true, promiseAmountMicros: 1_000_000 }),
    });
    const human = callDoc(a, {
      ...base,
      disposition: 'callback',
      mode: 'human',
      provider: 'whatsapp',
      whatsapp: {
        channelId: ids.number,
        answeredBy: owner.user._id,
        waCallId: null,
        direction: 'USER_INITIATED',
        conversationId: null,
        permissionId: null,
        timeline: [],
        metaStatus: null,
        metaDuration: null,
        metaErrors: [],
        ringUserIds: [],
        transferredTo: null,
      },
      insights: state({ hasSummary: false }),
    });
    const plain = callDoc(a, { ...base, agentUserId: viewer.user._id });
    await CallModel.collection.insertMany([promise, human, plain]);
    const req = {
      auth: {
        accountId: a.toString(),
        userId: owner.user._id.toString(),
        permissions: new Set<string>(),
      },
    } as never;
    const list = async (q: Record<string, string>) =>
      (await listCalls(req, ListCallsQuery.parse(q))).items.map((c) => c.id);
    expect(await list({ disposition: 'promise_to_pay,callback' })).toEqual(
      [plain, human, promise].slice(1).map((c) => c._id.toString()),
    );
    expect(await list({ sentiment: 'positive' })).toEqual([promise._id.toString()]);
    expect(await list({ hasPromise: 'true' })).toEqual([promise._id.toString()]);
    expect((await list({ hasPromise: 'false' })).sort()).toEqual(
      [human._id.toString(), plain._id.toString()].sort(),
    );
    expect(await list({ hasSummary: 'false' })).toContain(human._id.toString());
    expect(await list({ answeredBy: owner.user._id.toString() })).toEqual([human._id.toString()]);
    expect(await list({ answeredBy: viewer.user._id.toString() })).toEqual([plain._id.toString()]);
    expect(await list({ channelId: ids.number.toString() })).toEqual([human._id.toString()]);
    expect(ListCallsQuery.safeParse({ disposition: 'Bad Key' }).success).toBe(false);
    const view = await getCall(req, promise._id.toString());
    expect(view).toMatchObject({
      disposition: 'promise_to_pay',
      dispositionSource: 'ai',
      insights: {
        status: 'done',
        sentiment: 'positive',
        hasPromise: true,
        promiseAmountMicros: 1_000_000,
        hasSummary: true,
        reason: null,
      },
    });
    expect((await getCall(req, plain._id.toString())).insights).toBeNull();
    await AccountModel.exists({ _id: a });
  });
});

describe('report queries use indexes', () => {
  it('account rows and slice rows never scan the collection', async () => {
    const plan = async (filter: Record<string, unknown>) => {
      const explained = (await StatsDailyModel.find(filter).explain('queryPlanner')) as unknown as {
        queryPlanner: { winningPlan: unknown };
      };
      return JSON.stringify(explained.queryPlanner.winningPlan);
    };
    const range = { $gte: D1, $lte: D2 };
    const account = await plan({
      accountId: t.account._id,
      kind: 'all',
      refId: null,
      day: range,
      channel: { $in: ['voice'] },
      test: false,
    });
    const slices = await plan({
      accountId: t.account._id,
      kind: 'campaign',
      day: range,
      channel: { $in: ['voice'] },
    });
    for (const p of [account, slices]) {
      expect(p).toContain('IXSCAN');
      expect(p).not.toContain('COLLSCAN');
    }
  });
});
