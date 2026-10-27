import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEmail, MemoryEmailProvider, renderTemplate } from '../../src/core/email';
import { processEmailJob } from '../../src/core/queues/workers/email.worker';
import {
  processMaintenanceJob,
  REPORTS_EMAIL_JOB,
} from '../../src/core/queues/workers/maintenance.worker';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ReportSubscriptionModel } from '../../src/db/models/report-subscription.model';
import { StatsDailyModel } from '../../src/db/models/stats-daily.model';
import { UserModel } from '../../src/db/models/user.model';
import {
  duePeriod,
  formatKpi,
  sendDueReports,
  unsubscribeToken,
} from '../../src/modules/report-subscriptions/report-subscriptions.service';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const sent = useCapturedEmail();
const app = buildTestApp();
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const APP = 'https://app.example.com';
const API = 'https://api.example.com';

let t: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let agent: TestUser;

const base = '/api/v1/report-subscriptions';
const create = (u: TestUser, body: object) => request(app).post(base).set(auth(u)).send(body);

beforeAll(async () => {
  t = await createTestAccount({ timezone: 'Asia/Kolkata' });
  owner = await t.addUser('owner');
  viewer = await t.addUser('viewer');
  agent = await t.addUser('agent');
});

describe('duePeriod', () => {
  it('daily → yesterday', () => {
    expect(duePeriod('daily', '2026-03-01')).toEqual({
      key: '2026-02-28',
      from: '2026-02-28',
      to: '2026-02-28',
      previous: { from: '2026-02-27', to: '2026-02-27' },
      label: 'Yesterday (28 Feb 2026)',
    });
  });

  it('weekly → last Monday–Sunday, only on Mondays', () => {
    expect(duePeriod('weekly', '2026-09-08')).toBeNull();
    expect(duePeriod('weekly', '2026-12-28')).toMatchObject({
      key: 'W-2026-12-21',
      from: '2026-12-21',
      to: '2026-12-27',
      previous: { from: '2026-12-14', to: '2026-12-20' },
    });
  });

  it('monthly → last month, only on the 1st (across years and short months)', () => {
    expect(duePeriod('monthly', '2026-09-02')).toBeNull();
    expect(duePeriod('monthly', '2027-01-01')).toEqual({
      key: '2026-12',
      from: '2026-12-01',
      to: '2026-12-31',
      previous: { from: '2026-11-01', to: '2026-11-30' },
      label: 'Last month (Dec 2026)',
    });
    expect(duePeriod('monthly', '2026-03-01')).toMatchObject({
      from: '2026-02-01',
      to: '2026-02-28',
      previous: { from: '2026-01-01', to: '2026-01-31' },
    });
  });

  it('formats KPI values', () => {
    expect(formatKpi(null, 'count')).toBe('—');
    expect(formatKpi(12_345, 'count')).toBe('12,345');
    expect(formatKpi(42.5, 'percent')).toBe('42.5%');
    expect(formatKpi(45, 'seconds')).toBe('45s');
    expect(formatKpi(125, 'seconds')).toBe('2m 5s');
    expect(formatKpi(2_500_000, 'micros')).toBe('₹2.50');
  });
});

describe('/report-subscriptions', () => {
  beforeEach(() => ReportSubscriptionModel.deleteMany({ accountId: t.account._id }));

  it('needs reports.read and keeps each person to their own', async () => {
    expect((await create(agent, { frequency: 'daily' })).status).toBe(403);
    const mine = await create(viewer, { frequency: 'weekly', tabs: ['calls', 'calls'], hour: 8 });
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({
      frequency: 'weekly',
      tabs: ['calls'],
      hour: 8,
      active: true,
      lastSentPeriod: null,
    });
    const ownerList = await request(app).get(base).set(auth(owner));
    expect(ownerList.body.data).toEqual([]);
    const id = mine.body.data.id as string;
    expect(
      (await request(app).patch(`${base}/${id}`).set(auth(owner)).send({ hour: 3 })).status,
    ).toBe(404);
    expect((await request(app).delete(`${base}/${id}`).set(auth(owner))).status).toBe(404);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect((await request(app).get(base).set(auth(stranger))).body.data).toEqual([]);
  });

  it('creates with defaults, changes, pauses and deletes — audited', async () => {
    const res = await create(owner, { frequency: 'daily' });
    expect(res.body.data).toMatchObject({ tabs: ['overview'], hour: 9 });
    const id = res.body.data.id as string;
    const patched = await request(app)
      .patch(`${base}/${id}`)
      .set(auth(owner))
      .send({ active: false, tabs: ['whatsapp', 'team'] });
    expect(patched.body.data).toMatchObject({ active: false, tabs: ['whatsapp', 'team'] });
    expect((await request(app).patch(`${base}/${id}`).set(auth(owner)).send({})).status).toBe(422);
    expect(
      (await request(app).patch(`${base}/${id}`).set(auth(owner)).send({ hour: 24 })).status,
    ).toBe(422);
    expect((await request(app).get(base).set(auth(owner))).body.data).toHaveLength(1);
    expect((await request(app).delete(`${base}/${id}`).set(auth(owner))).status).toBe(204);
    expect((await request(app).delete(`${base}/${id}`).set(auth(owner))).status).toBe(404);
    expect((await request(app).delete(`${base}/nope`).set(auth(owner))).status).toBe(422);
    const actions = (
      await AuditLogModel.find({
        accountId: t.account._id,
        'target.id': id,
      }).lean()
    ).map((a) => a.action);
    expect(actions).toEqual([
      'report_subscription.created',
      'report_subscription.updated',
      'report_subscription.deleted',
    ]);
  });

  it('allows at most five each', async () => {
    for (let i = 0; i < 5; i += 1)
      expect((await create(owner, { frequency: 'daily', hour: i })).status).toBe(201);
    const sixth = await create(owner, { frequency: 'daily' });
    expect([sixth.status, sixth.body.error.code]).toEqual([422, 'REPORT_SUBSCRIPTION_LIMIT']);
    expect((await create(viewer, { frequency: 'monthly' })).status).toBe(201);
  });

  it('rejects unknown tabs and fields', async () => {
    expect((await create(owner, { frequency: 'daily', tabs: ['flows'] })).status).toBe(422);
    expect((await create(owner, { frequency: 'hourly' })).status).toBe(422);
    expect((await create(owner, { frequency: 'daily', email: 'x@y.z' })).status).toBe(422);
  });

  it('allows reading but blocks mutations while impersonating', async () => {
    const res = await create(owner, { frequency: 'daily' });
    const id = res.body.data.id as string;
    const token = await tokenFor(owner.user, { imp: new Types.ObjectId().toString() });
    const authorization = `Bearer ${token}`;
    expect((await request(app).get(base).set({ authorization })).status).toBe(200);
    expect(
      (await request(app).post(base).set({ authorization }).send({ frequency: 'daily' })).status,
    ).toBe(403);
    expect(
      (await request(app).patch(`${base}/${id}`).set({ authorization }).send({ active: false }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(`${base}/${id}`).set({ authorization })).status).toBe(403);
  });

  it('enforces the five-subscription limit during concurrent creates', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => create(owner, { frequency: 'daily' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 422)).toHaveLength(3);
    expect(
      await ReportSubscriptionModel.countDocuments({
        accountId: t.account._id,
        userId: owner.user._id,
      }),
    ).toBe(5);
  });
});

describe('sendDueReports', () => {
  // 09:10 in Kolkata on Monday 7 Sep 2026
  const MONDAY_9 = new Date('2026-09-07T03:40:00Z');

  beforeEach(async () => {
    await ReportSubscriptionModel.deleteMany({});
    sent.length = 0;
  });

  it('sends once per period at the account-local hour, numbers only', async () => {
    await StatsDailyModel.collection.insertMany([
      {
        accountId: t.account._id,
        day: '2026-09-06',
        channel: 'voice',
        test: false,
        kind: 'all',
        refId: null,
        counters: { calls_attempted: 10, calls_answered: 5, talk_sec: 600 },
      },
      {
        accountId: t.account._id,
        day: '2026-09-05',
        channel: 'voice',
        test: false,
        kind: 'all',
        refId: null,
        counters: { calls_attempted: 4, calls_answered: 4, talk_sec: 100 },
      },
    ] as never[]);
    const daily = await ReportSubscriptionModel.create({
      accountId: t.account._id,
      userId: owner.user._id,
      frequency: 'daily',
      tabs: ['overview', 'calls'],
      hour: 9,
    });
    await ReportSubscriptionModel.create([
      // wrong hour
      {
        accountId: t.account._id,
        userId: owner.user._id,
        frequency: 'daily',
        tabs: ['overview'],
        hour: 10,
      },
      // weekly on a Monday → last week
      {
        accountId: t.account._id,
        userId: viewer.user._id,
        frequency: 'weekly',
        tabs: ['whatsapp'],
        hour: 9,
      },
      // not the 1st
      {
        accountId: t.account._id,
        userId: viewer.user._id,
        frequency: 'monthly',
        tabs: ['team'],
        hour: 9,
      },
      // paused
      {
        accountId: t.account._id,
        userId: viewer.user._id,
        frequency: 'daily',
        tabs: ['overview'],
        hour: 9,
        active: false,
      },
    ]);

    const first = await sendDueReports({ appUrl: APP, apiUrl: API, logger, now: () => MONDAY_9 });
    expect(first).toEqual({ subscriptions: 4, sent: 2, skipped: 0 });
    expect(sent.map((s) => s.template)).toEqual(['reports.digest', 'reports.digest']);
    const mail = sent.find((s) => s.to === owner.user.email);
    expect(mail?.dedupeKey).toBe(`report-${daily._id.toString()}-2026-09-06`);
    const vars = mail?.vars as {
      periodLabel: string;
      sections: { title: string; rows: { label: string; value: string; previous: string }[] }[];
      reportUrl: string;
      unsubscribeUrl: string;
    };
    expect(vars.periodLabel).toBe('Yesterday (6 Sep 2026)');
    expect(vars.sections.map((s) => s.title)).toEqual(['Overview', 'Calls']);
    expect(vars.sections[0]?.rows.find((r) => r.label === 'Calls')).toEqual({
      label: 'Calls',
      value: '10',
      previous: '4',
    });
    expect(vars.reportUrl).toBe(
      `${APP}/reports?range=custom&from=2026-09-06&to=2026-09-06&compare=1`,
    );
    expect(vars.unsubscribeUrl).toMatch(
      new RegExp(`^${APP}/report-emails/unsubscribe\\?token=${daily._id.toString()}\\.`),
    );
    expect((vars as unknown as { oneClickUrl: string }).oneClickUrl).toMatch(
      new RegExp(`^${API}/api/v1/report-unsubscribe\\?token=${daily._id.toString()}\\.`),
    );
    expect(JSON.stringify(vars)).not.toContain('+91');
    expect(sent.find((s) => s.to === viewer.user.email)?.dedupeKey).toMatch(/-W-2026-08-31$/);

    // the same hour again (a retry) sends nothing more
    expect(
      await sendDueReports({ appUrl: APP, apiUrl: API, logger, now: () => MONDAY_9 }),
    ).toMatchObject({
      sent: 0,
    });
    expect((await ReportSubscriptionModel.findById(daily._id).lean())?.lastSentPeriod).toBe(
      '2026-09-06',
    );
    // the next day sends the next period
    const tuesday = new Date('2026-09-08T03:40:00Z');
    expect(
      await sendDueReports({ appUrl: APP, apiUrl: API, logger, now: () => tuesday }),
    ).toMatchObject({
      sent: 1,
    });
  });

  it('follows each account timezone', async () => {
    const ny = await createTestAccount({ timezone: 'America/New_York' });
    const person = await ny.addUser('owner');
    await ReportSubscriptionModel.create({
      accountId: ny.account._id,
      userId: person.user._id,
      frequency: 'monthly',
      tabs: ['overview'],
      hour: 0,
    });
    // 04:30 UTC on 1 Oct = 00:30 on 1 Oct in New York (EDT)
    const result = await sendDueReports({
      appUrl: APP,
      apiUrl: API,
      logger,
      now: () => new Date('2026-10-01T04:30:00Z'),
    });
    expect(result.sent).toBe(1);
    expect(sent[0]?.dedupeKey).toMatch(/-2026-09$/);
    // 23:30 on 30 Sep in New York → nothing yet
    await ReportSubscriptionModel.updateMany({}, { $set: { lastSentPeriod: null } });
    sent.length = 0;
    expect(
      (
        await sendDueReports({
          appUrl: APP,
          apiUrl: API,
          logger,
          now: () => new Date('2026-10-01T03:30:00Z'),
        })
      ).sent,
    ).toBe(0);
  });

  it('keeps a failed enqueue due so a worker retry can deliver the period', async () => {
    const sub = await ReportSubscriptionModel.create({
      accountId: t.account._id,
      userId: owner.user._id,
      frequency: 'daily',
      tabs: ['overview'],
      hour: 9,
    });
    const enqueue = vi
      .spyOn(getEmail(), 'enqueue')
      .mockRejectedValueOnce(new Error('Queue offline'));
    try {
      const deps = { appUrl: APP, apiUrl: API, logger, now: () => MONDAY_9 };
      await expect(sendDueReports(deps)).rejects.toThrow('Queue offline');
      expect((await ReportSubscriptionModel.findById(sub._id).lean())?.lastSentPeriod).toBeNull();
      expect(await sendDueReports(deps)).toMatchObject({ sent: 1 });
      expect((await ReportSubscriptionModel.findById(sub._id).lean())?.lastSentPeriod).toBe(
        '2026-09-06',
      );
      expect(sent).toHaveLength(1);
    } finally {
      enqueue.mockRestore();
    }
  });

  it('skips people who left, lost reports.read, or whose account is suspended', async () => {
    const other = await createTestAccount({ timezone: 'Asia/Kolkata' });
    const gone = await other.addUser('viewer');
    const demoted = await other.addUser('agent');
    await ReportSubscriptionModel.create([
      {
        accountId: other.account._id,
        userId: gone.user._id,
        frequency: 'daily',
        tabs: ['overview'],
        hour: 9,
      },
      {
        accountId: other.account._id,
        userId: demoted.user._id,
        frequency: 'daily',
        tabs: ['overview'],
        hour: 9,
      },
    ]);
    await UserModel.updateOne({ _id: gone.user._id }, { $set: { status: 'disabled' } });
    expect(await sendDueReports({ appUrl: APP, apiUrl: API, logger, now: () => MONDAY_9 })).toEqual(
      {
        subscriptions: 2,
        sent: 0,
        skipped: 2,
      },
    );
    await AccountModel.updateOne({ _id: other.account._id }, { $set: { status: 'suspended' } });
    expect(await sendDueReports({ appUrl: APP, apiUrl: API, logger, now: () => MONDAY_9 })).toEqual(
      {
        subscriptions: 2,
        sent: 0,
        skipped: 0,
      },
    );
  });

  it('runs as the reports-email maintenance job', async () => {
    const result = await processMaintenanceJob({ logger })({ name: REPORTS_EMAIL_JOB } as never);
    expect(result).toMatchObject({ subscriptions: 0, sent: 0 });
  });

  it('rechecks subscription, user, role and account access at actual mail delivery', async () => {
    const account = await createTestAccount({ timezone: 'Asia/Kolkata' });
    const user = await account.addUser('owner');
    const sub = await ReportSubscriptionModel.create({
      accountId: account.account._id,
      userId: user.user._id,
      frequency: 'daily',
      hour: 9,
    });
    await sendDueReports({ appUrl: APP, apiUrl: API, logger, now: () => MONDAY_9 });
    const data = sent.find((s) => s.to === user.user.email);
    const provider = new MemoryEmailProvider();
    const deliver = () => processEmailJob(provider)({ data } as never, 'test');
    expect(await deliver()).toEqual({ messageId: 'mem-1' });
    expect(provider.sent[0]?.text).not.toContain(user.user.name);
    await ReportSubscriptionModel.updateOne({ _id: sub._id }, { $set: { active: false } });
    expect(await deliver()).toEqual({ messageId: 'report-skipped' });
    await ReportSubscriptionModel.updateOne({ _id: sub._id }, { $set: { active: true } });
    await UserModel.updateOne({ _id: user.user._id }, { $set: { status: 'disabled' } });
    expect(await deliver()).toEqual({ messageId: 'report-skipped' });
    await UserModel.updateOne(
      { _id: user.user._id },
      { $set: { status: 'active', roleId: account.roles.agent } },
    );
    expect(await deliver()).toEqual({ messageId: 'report-skipped' });
    await UserModel.updateOne({ _id: user.user._id }, { $set: { roleId: account.roles.owner } });
    await AccountModel.updateOne({ _id: account.account._id }, { $set: { status: 'suspended' } });
    expect(await deliver()).toEqual({ messageId: 'report-skipped' });
    await ReportSubscriptionModel.deleteOne({ _id: sub._id });
    expect(await deliver()).toEqual({ messageId: 'report-skipped' });
    expect(provider.sent).toHaveLength(1);
  });
});

describe('POST /report-unsubscribe', () => {
  it('stops the e-mail with a valid link; refuses tampered, old or unknown ones', async () => {
    const sub = await ReportSubscriptionModel.create({
      accountId: t.account._id,
      userId: owner.user._id,
      frequency: 'daily',
      tabs: ['overview'],
      hour: 9,
    });
    const id = sub._id.toString();
    const unsub = (token: string) =>
      request(app).post('/api/v1/report-unsubscribe').send({ token });
    const token = unsubscribeToken(id);
    const tampered = token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect((await unsub(tampered)).status).toBe(422);
    const old = unsubscribeToken(id, new Date(Date.now() - 91 * 86_400_000));
    const expired = await unsub(old);
    expect([expired.status, expired.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    const otherId = unsubscribeToken(new Types.ObjectId().toString());
    expect((await unsub(`${id}.${otherId.split('.').slice(1).join('.')}`)).status).toBe(422);
    expect((await unsub('not-a-token-at-all')).status).toBe(422);
    expect((await unsub(`${token}.extra`)).status).toBe(422);
    expect((await ReportSubscriptionModel.findById(id).lean())?.active).toBe(true);

    const ok = await unsub(token);
    expect([ok.status, ok.body.data]).toEqual([200, { stopped: true }]);
    expect((await ReportSubscriptionModel.findById(id).lean())?.active).toBe(false);
    expect((await unsub(token)).status).toBe(200); // again: still fine

    // a mail app's one-click POST: form body, token in the query
    await ReportSubscriptionModel.updateOne({ _id: sub._id }, { $set: { active: true } });
    const oneClick = await request(app)
      .post(`/api/v1/report-unsubscribe?token=${encodeURIComponent(token)}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(oneClick.status).toBe(200);
    expect((await ReportSubscriptionModel.findById(id).lean())?.active).toBe(false);
    expect((await request(app).post('/api/v1/report-unsubscribe').send({})).status).toBe(422);
  });
});

describe('reports.digest e-mail', () => {
  it('escapes everything and carries both links', () => {
    const mail = renderTemplate('reports.digest', {
      subscriptionId: new Types.ObjectId().toString(),
      accountName: '<b>Acme</b>',
      periodLabel: 'Yesterday (6 Sep 2026)',
      sections: [{ title: 'Calls', rows: [{ label: 'Answered', value: '5', previous: '<4>' }] }],
      reportUrl: 'https://app.example.com/reports?range=custom',
      unsubscribeUrl: 'https://app.example.com/report-emails/unsubscribe?token=a.b.c',
      oneClickUrl: 'https://api.example.com/api/v1/report-unsubscribe?token=a.b.c',
    });
    expect(mail.headers).toEqual({
      'List-Unsubscribe': '<https://api.example.com/api/v1/report-unsubscribe?token=a.b.c>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(mail.subject).toBe('<b>Acme</b>: report for Yesterday (6 Sep 2026)');
    expect(mail.html).not.toContain('<b>Acme');
    expect(mail.html).toContain('&lt;4&gt;');
    expect(mail.html).toContain('Stop these e-mails');
    expect(mail.text).toContain('- Answered: 5 (before: <4>)');
    expect(mail.text).toContain('Stop these e-mails: https://app.example.com/report-emails/');
  });
});
