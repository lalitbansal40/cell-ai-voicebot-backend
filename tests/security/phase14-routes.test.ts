import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { ReportSubscriptionModel } from '../../src/db/models/report-subscription.model';
import { StatsDailyModel } from '../../src/db/models/stats-daily.model';
import { SYSTEM_ROLES, type SystemRoleKey } from '../../src/modules/rbac/system-roles';
import { callDoc } from '../helpers/analytics';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage, contactJobs: recordingContactJobs().jobs });
const auth = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: (ids: Ids) => string;
  permission: string;
  body?: object;
}
interface Ids {
  call: string;
  conversation: string;
  exportJob: string;
  subscription: string;
}

/** Every Phase 14 route that takes an id of the account's data. */
const ID_ROUTES: Route[] = [
  { method: 'get', path: (i) => `/api/v1/calls/${i.call}/insights`, permission: 'calls.read' },
  {
    method: 'post',
    path: (i) => `/api/v1/calls/${i.call}/insights/regenerate`,
    permission: 'calls.listen',
  },
  {
    method: 'patch',
    path: (i) => `/api/v1/calls/${i.call}/disposition`,
    permission: 'calls.trigger',
    body: { disposition: 'callback' },
  },
  {
    method: 'get',
    path: (i) => `/api/v1/inbox/conversations/${i.conversation}/summary`,
    permission: 'inbox.read',
  },
  {
    method: 'post',
    path: (i) => `/api/v1/inbox/conversations/${i.conversation}/summary`,
    permission: 'inbox.reply',
  },
  { method: 'get', path: (i) => `/api/v1/exports/${i.exportJob}`, permission: 'calls.export' },
  {
    method: 'patch',
    path: (i) => `/api/v1/report-subscriptions/${i.subscription}`,
    permission: 'reports.read',
    body: { hour: 7 },
  },
  {
    method: 'delete',
    path: (i) => `/api/v1/report-subscriptions/${i.subscription}`,
    permission: 'reports.read',
  },
];

/** Account-wide Phase 14 routes (the account comes from the token only). */
const ACCOUNT_ROUTES: Route[] = [
  { method: 'get', path: () => '/api/v1/reports/overview', permission: 'reports.read' },
  { method: 'get', path: () => '/api/v1/reports/team', permission: 'reports.read' },
  { method: 'get', path: () => '/api/v1/account/insights-settings', permission: 'account.read' },
  {
    method: 'put',
    path: () => '/api/v1/account/insights-settings',
    permission: 'account.update',
    body: { enabled: true },
  },
  { method: 'get', path: () => '/api/v1/account/dispositions', permission: 'account.read' },
  { method: 'get', path: () => '/api/v1/account/retention', permission: 'account.read' },
  {
    method: 'put',
    path: () => '/api/v1/account/retention',
    permission: 'account.update',
    body: { callsDays: null },
  },
  {
    method: 'post',
    path: () => '/api/v1/exports/calls',
    permission: 'calls.export',
    body: { from: '2026-01-01', to: '2026-01-02' },
  },
  {
    method: 'post',
    path: () => '/api/v1/exports/report',
    permission: 'reports.export',
    body: { tab: 'overview', query: { from: '2026-01-01', to: '2026-01-02' } },
  },
  { method: 'get', path: () => '/api/v1/exports', permission: 'calls.export' },
  { method: 'get', path: () => '/api/v1/report-subscriptions', permission: 'reports.read' },
];

const ROLES: SystemRoleKey[] = ['owner', 'manager', 'agent', 'viewer'];

let a: TestAccount;
let b: TestAccount;
const users = {} as Record<SystemRoleKey, TestUser>;
let stranger: TestUser;
let ids: Ids;

const send = (u: { token: string }, route: Route, i: Ids) => {
  const req = request(app)[route.method](route.path(i)).set(auth(u));
  return route.body ? req.send(route.body) : req;
};

beforeAll(async () => {
  a = await createTestAccount();
  b = await createTestAccount();
  for (const role of ROLES) users[role] = await a.addUser(role);
  stranger = await b.addUser('owner');
  const call = callDoc(a.account._id, {
    provider: 'webcall',
    variables: {},
    outcome: {},
    metrics: emptyCallMetrics(),
    cost: emptyCallCost(),
    recording: null,
    flowRunId: null,
    error: null,
    languageDetected: null,
    insights: null,
    dispositionSource: null,
  });
  await CallModel.collection.insertOne(call);
  const conversation = new Types.ObjectId();
  await ConversationModel.collection.insertOne({
    _id: conversation,
    accountId: a.account._id,
    channelId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
  });
  const exportJob = await ExportJobModel.create({
    accountId: a.account._id,
    kind: 'calls',
    format: 'csv',
    scope: 'records',
    filter: {},
    columns: [],
    status: 'pending',
    progress: { processed: 0, total: 0 },
    createdBy: users.owner.user._id,
  });
  const subscription = await ReportSubscriptionModel.create({
    accountId: a.account._id,
    userId: users.owner.user._id,
    frequency: 'daily',
    tabs: ['overview'],
    hour: 9,
  });
  ids = {
    call: call._id.toString(),
    conversation: conversation.toString(),
    exportJob: exportJob._id.toString(),
    subscription: subscription._id.toString(),
  };
});

describe('Phase 14 routes — tenant isolation', () => {
  it("another account's owner never reaches this account's calls, chats, exports or report e-mails", async () => {
    for (const route of ID_ROUTES) {
      const res = await send(stranger, route, ids);
      expect([route.method, route.path(ids), res.status]).toEqual([
        route.method,
        route.path(ids),
        404,
      ]);
    }
    // nothing changed for the owner account
    expect(await ReportSubscriptionModel.exists({ _id: ids.subscription, hour: 9 })).toBeTruthy();
    expect((await CallModel.findById(ids.call).lean())?.disposition).toBeNull();
  });

  it("reports read only the caller's own rollups", async () => {
    await StatsDailyModel.collection.insertOne({
      accountId: a.account._id,
      day: '2026-09-01',
      channel: 'voice',
      test: false,
      kind: 'all',
      refId: null,
      counters: { calls_attempted: 42 },
    });
    const q = '?from=2026-09-01&to=2026-09-01';
    const mine = await request(app).get(`/api/v1/reports/overview${q}`).set(auth(users.owner));
    const theirs = await request(app).get(`/api/v1/reports/overview${q}`).set(auth(stranger));
    const attempted = (r: request.Response) =>
      (r.body.data.kpis as { key: string; value: number }[]).find(
        (k) => k.key === 'calls_attempted',
      )?.value;
    expect(attempted(mine)).toBe(42);
    expect(attempted(theirs)).toBe(0);
  });
});

describe('Phase 14 routes — permission matrix', () => {
  it('each role reaches exactly the routes its permissions allow', async () => {
    const seen: Record<string, Record<string, boolean>> = {};
    for (const route of [...ACCOUNT_ROUTES, ...ID_ROUTES])
      for (const role of ROLES) {
        const res = await send(users[role], route, ids);
        const allowed = (SYSTEM_ROLES[role].permissions as string[]).includes(route.permission);
        const key = `${route.method.toUpperCase()} ${route.path({ call: ':id', conversation: ':id', exportJob: ':id', subscription: ':id' })}`;
        seen[key] = { ...(seen[key] ?? {}), [role]: res.status !== 403 };
        expect([key, role, res.status === 403]).toEqual([key, role, !allowed]);
      }
    expect(seen).toMatchSnapshot();
  });
});

describe('Phase 14 — public unsubscribe and audit details', () => {
  it('rate-limits the public unsubscribe link (20 / min / IP)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1)
      statuses.push(
        (
          await request(app)
            .post('/api/v1/report-unsubscribe')
            .send({ token: 'x'.repeat(20) })
        ).status,
      );
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('audit details of the new actions hold no phone numbers or customer text', async () => {
    const logs = await AuditLogModel.find({
      accountId: a.account._id,
      action: {
        $regex:
          /^(report|report_subscription|account\.(retention|insights|dispositions)|call\.(disposition|insights))/,
      },
    }).lean();
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs.map((l) => l.meta));
    expect(text).not.toMatch(/\+?91\d{10}/);
    // keys like `includeSummary` are fine; summary / transcript text never
    expect(text).not.toMatch(/Customer said|Demo: |haan ji/i);
  });
});
