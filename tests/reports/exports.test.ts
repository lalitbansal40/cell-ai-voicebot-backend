import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { REPORT_LIMITS } from '../../src/config/limits';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallInsightModel } from '../../src/db/models/call-insight.model';
import { CallModel, emptyCallCost } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { MessageModel } from '../../src/db/models/message.model';
import { RoleModel } from '../../src/db/models/role.model';
import { StatsDailyModel } from '../../src/db/models/stats-daily.model';
import { UserModel } from '../../src/db/models/user.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { readStoredFile } from '../../src/modules/contact-imports/storage-io';
import { acquireJobLock, releaseJobLock } from '../../src/modules/contacts/locks';
import {
  CALL_HEADERS,
  downloadNameOf,
  MESSAGE_HEADERS,
  runRecordExport,
} from '../../src/modules/record-exports/record-exports.service';
import { createLogger } from '../../src/shared/logger';
import { callDoc, messageDoc } from '../helpers/analytics';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const rec = recordingContactJobs();
const app = buildTestApp({}, { storage, contactJobs: rec.jobs });
const deps = { storage, logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }) };
const auth = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let viewer: TestUser;
let agent: TestUser;
let callsOnly: { token: string };
let channel: Types.ObjectId;

// 2026-09-01 / 02 in Asia/Kolkata (UTC+5:30)
const SEP1 = new Date('2026-09-01T06:00:00Z');
const SEP2 = new Date('2026-09-02T06:00:00Z');
const LATE_SEP2 = new Date('2026-09-02T19:00:00Z'); // 00:30 on 3 Sep, local

const post = (u: { token: string }, path: string, body: object) =>
  request(app).post(`/api/v1/exports/${path}`).set(auth(u)).send(body);

/** Minimal RFC 4180 reader (quoted cells, doubled quotes). */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
};

/** Runs the queued job and returns the file as rows. */
const runAndRead = async (exportId: string) => {
  const result = await runRecordExport(
    { accountId: t.account._id.toString(), exportJobId: exportId },
    deps,
  );
  const job = await ExportJobModel.findById(exportId).lean();
  const text = job?.fileKey ? (await readStoredFile(storage, job.fileKey)).toString('utf8') : '';
  return {
    result,
    job,
    text,
    rows: parseCsv(text.replace(/^\uFEFF/, '')),
  };
};

afterEach(async () => {
  // a failed assertion must not leave the per-account lock behind
  await ExportJobModel.updateMany(
    { accountId: t.account._id, status: { $in: ['pending', 'processing'] } },
    { $set: { status: 'failed' } },
  );
  for (const j of await ExportJobModel.find({ accountId: t.account._id }).lean())
    await releaseJobLock('records-export', t.account._id.toString(), j._id.toString());
});

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
  agent = await t.addUser('agent');
  const role = await RoleModel.create({
    accountId: t.account._id,
    key: 'calls_exporter',
    name: 'Calls exporter',
    permissions: ['account.read', 'calls.read', 'calls.export'],
    isSystem: false,
  });
  const user = await UserModel.create({
    accountId: t.account._id,
    roleId: role._id,
    name: 'Exporter',
    email: `exporter-${new Types.ObjectId().toString()}@example.com`,
    passwordHash: 'x',
    status: 'active',
    emailVerifiedAt: new Date(),
  });
  callsOnly = { token: await tokenFor(user.toObject({ transform: false })) };

  const contact = await ContactModel.create({
    accountId: t.account._id,
    phoneE164: '+919812345678',
    name: '=HYPERLINK("x")',
    source: { type: 'manual' },
  });
  channel = (
    await WhatsAppChannelModel.collection.insertOne({
      accountId: t.account._id,
      label: 'Support line',
      phoneNumberId: 'pn-1',
    })
  ).insertedId;
  const answered = callDoc(t.account._id, {
    createdAt: SEP1,
    provider: 'sip',
    contactId: contact._id,
    disposition: 'promised_to_pay',
    dispositionSource: 'ai',
    insights: { sentiment: 'positive', hasPromise: true, hasSummary: true },
    cost: { ...emptyCallCost(), totalMicros: 1_250_000 },
    source: { kind: 'flow', flowId: null },
  });
  await CallModel.collection.insertMany([
    answered,
    callDoc(t.account._id, {
      createdAt: SEP2,
      provider: 'whatsapp',
      status: 'no_answer',
      contactId: contact._id,
      whatsapp: { channelId: channel, answeredBy: owner.user._id },
      cost: emptyCallCost(),
    }),
    callDoc(t.account._id, { createdAt: LATE_SEP2, provider: 'webcall', cost: emptyCallCost() }),
    // another account's call never shows up
    callDoc(new Types.ObjectId(), { createdAt: SEP1, provider: 'sip', cost: emptyCallCost() }),
  ] as never[]);
  await CallInsightModel.create({
    accountId: t.account._id,
    callId: answered._id,
    version: 1,
    status: 'done',
    output: {
      summary: 'Customer agreed to pay on Friday.',
      keyInfo: { promiseDate: '2026-09-05', promiseAmountMicros: 5_000_000_000 },
    },
  });
  await MessageModel.collection.insertMany([
    messageDoc(t.account._id, {
      at: SEP1,
      channelId: channel,
      sentBy: owner.user._id,
      text: { body: 'secret message text' },
    }),
    messageDoc(t.account._id, {
      at: SEP2,
      channelId: channel,
      direction: 'in',
      origin: 'customer',
      status: 'received',
      template: null,
      text: { body: 'another private text' },
    }),
    messageDoc(t.account._id, { at: SEP2, channelId: channel, type: 'note' }),
  ] as never[]);
});

describe('POST /exports/calls', () => {
  it('needs calls.export; full phones need contacts.export too', async () => {
    expect((await post(viewer, 'calls', {})).status).toBe(403);
    expect((await post(agent, 'calls', {})).status).toBe(403);
    const phone = await post(callsOnly, 'calls', { includePhone: true });
    expect(phone.status).toBe(403);
    const masked = await post(callsOnly, 'calls', { from: '2026-09-01', to: '2026-09-01' });
    expect(masked.status).toBe(202);
    const { rows } = await runAndRead(masked.body.data.id as string);
    expect(rows[1]?.[5]).toBe('+91******5678');
  });

  it('exports the filtered days in the account timezone with masked phones and safe cells', async () => {
    const res = await post(manager, 'calls', { from: '2026-09-01', to: '2026-09-02' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      kind: 'calls',
      format: 'csv',
      status: 'pending',
      progress: { processed: 0, total: 2 },
    });
    expect(rec.queued.at(-1)).toEqual({
      name: 'records.export',
      data: { accountId: t.account._id.toString(), exportJobId: res.body.data.id },
    });
    const { result, rows, job } = await runAndRead(res.body.data.id as string);
    expect(result).toEqual({ status: 'ready', rows: 2 });
    expect(job).toMatchObject({ status: 'ready', rowCount: 2, scope: 'records' });
    expect(rows[0]).toEqual([...CALL_HEADERS]);
    const [first, second] = [rows[1] ?? [], rows[2] ?? []];
    expect(first.slice(1, 9)).toEqual([
      'outbound',
      'sip',
      '',
      '\'=HYPERLINK("x")',
      '+91******5678',
      'completed',
      '30',
      'promised_to_pay',
    ]);
    expect(first.slice(9, 13)).toEqual(['ai', 'positive', '2026-09-05', '₹5,000.00']);
    expect(first[16]).toBe('₹1.25');
    expect(second[3]).toBe('Support line');
    expect(second[15]).toBe(owner.user.name);
    expect(rows).toHaveLength(3); // the 00:30-on-3-Sep call stays out
  });

  it('adds full phones and AI summaries on request', async () => {
    const res = await post(owner, 'calls', {
      from: '2026-09-01',
      to: '2026-09-01',
      includePhone: true,
      includeSummary: true,
      format: 'csv',
    });
    const { rows } = await runAndRead(res.body.data.id as string);
    expect(rows[0]?.at(-1)).toBe('AI summary');
    expect(rows[1]?.[5]).toBe('+919812345678');
    expect(rows[1]?.at(-1)).toBe('Customer agreed to pay on Friday.');
    const id = res.body.data.id as string;
    expect((await request(app).get(`/api/v1/exports/${id}`).set(auth(callsOnly))).status).toBe(404);
    const visible = await request(app).get('/api/v1/exports?limit=100').set(auth(callsOnly));
    expect((visible.body.data as { id: string }[]).map((j) => j.id)).not.toContain(id);
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'report.exported',
      'meta.includeSummary': true,
    }).lean();
    expect(audit?.meta).toMatchObject({ kind: 'calls', rows: 1, includePhone: true });
  });

  it('filters by outcome and refuses too many rows or a second export at once', async () => {
    const byName = await post(manager, 'calls', { q: 'hyperlink', hasSummary: true });
    expect(byName.body.data.progress.total).toBe(1);
    await runAndRead(byName.body.data.id as string);
    const none = await post(manager, 'calls', { disposition: ['callback'] });
    expect(none.body.data.progress.total).toBe(0);
    const empty = await runAndRead(none.body.data.id as string);
    expect(empty.result).toEqual({ status: 'ready', rows: 0 });

    const limits = REPORT_LIMITS as { exportMaxRows: number };
    const before = limits.exportMaxRows;
    limits.exportMaxRows = 1;
    try {
      const big = await post(manager, 'calls', {});
      expect([big.status, big.body.error.code]).toEqual([409, 'CONFLICT_INVALID_STATE']);
    } finally {
      limits.exportMaxRows = before;
    }

    expect(await acquireJobLock('records-export', t.account._id.toString(), 'busy')).toBe(true);
    try {
      const busy = await post(manager, 'calls', {});
      expect(busy.status).toBe(409);
      expect(busy.body.error.message).toMatch(/Another export/);
    } finally {
      await releaseJobLock('records-export', t.account._id.toString(), 'busy');
    }
  });

  it('writes XLSX too', async () => {
    const res = await post(manager, 'calls', {
      format: 'xlsx',
      from: '2026-09-01',
      to: '2026-09-02',
    });
    await runRecordExport(
      { accountId: t.account._id.toString(), exportJobId: res.body.data.id },
      deps,
    );
    const job = await ExportJobModel.findById(res.body.data.id).lean();
    const file = await readStoredFile(storage, job?.fileKey as string);
    expect(file.subarray(0, 2).toString()).toBe('PK');
  });

  it('rejects impossible dates and reversed ranges before queuing', async () => {
    for (const path of ['calls', 'messages']) {
      expect((await post(manager, path, { from: '2026-02-30', to: '2026-03-01' })).status).toBe(
        422,
      );
      expect((await post(manager, path, { from: '2026-09-02', to: '2026-09-01' })).status).toBe(
        422,
      );
    }
  });

  it('fails rather than silently truncating when matching records grow past the cap', async () => {
    const res = await post(manager, 'calls', { from: '2026-09-01', to: '2026-09-02' });
    const limits = REPORT_LIMITS as { exportMaxRows: number };
    const before = limits.exportMaxRows;
    limits.exportMaxRows = 1;
    try {
      const { result, job } = await runAndRead(res.body.data.id as string);
      expect(result.status).toBe('failed');
      expect(job?.fileKey).toBeNull();
      expect(job?.errorMessage).toContain('exceeds 1 rows');
    } finally {
      limits.exportMaxRows = before;
    }
  });

  it('is blocked while impersonating', async () => {
    const imp = await tokenFor(owner.user, { imp: new Types.ObjectId().toString() });
    expect((await post({ token: imp }, 'calls', {})).status).toBe(403);
  });
});

describe('POST /exports/messages', () => {
  it('exports message metadata only — never the text, never notes', async () => {
    expect(
      (await post(callsOnly, 'messages', { from: '2026-09-01', to: '2026-09-02' })).status,
    ).toBe(403);
    const res = await post(manager, 'messages', { from: '2026-09-01', to: '2026-09-02' });
    expect(res.status).toBe(202);
    expect(res.body.data.progress.total).toBe(2);
    const { rows, text } = await runAndRead(res.body.data.id as string);
    expect(rows[0]).toEqual([...MESSAGE_HEADERS]);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.slice(1, 7)).toEqual([
      'out',
      'text',
      'sent',
      '',
      'Support line',
      owner.user.name,
    ]);
    expect(text).not.toContain('secret message text');
    expect(text).not.toContain('another private text');
    const inbound = await post(manager, 'messages', {
      from: '2026-09-01',
      to: '2026-09-02',
      direction: 'in',
      channelId: channel.toString(),
    });
    expect(inbound.body.data.progress.total).toBe(1);
  });

  it('needs both days', async () => {
    expect((await post(manager, 'messages', { from: '2026-09-01' })).status).toBe(422);
  });
});

describe('POST /exports/report', () => {
  it('exports one tab with its KPIs and table', async () => {
    await StatsDailyModel.collection.insertOne({
      accountId: t.account._id,
      day: '2026-09-01',
      channel: 'voice',
      test: false,
      kind: 'all',
      refId: null,
      counters: { calls_attempted: 4, calls_answered: 3, talk_sec: 120 },
    });
    expect((await post(viewer, 'report', { tab: 'overview' })).status).toBe(403);
    const bad = await post(manager, 'report', {
      tab: 'overview',
      query: { from: '2026-09-02', to: '2026-09-01' },
    });
    expect([bad.status, bad.body.error.code]).toEqual([422, 'REPORT_RANGE_INVALID']);
    const res = await post(manager, 'report', {
      tab: 'calls',
      query: { from: '2026-09-01', to: '2026-09-01' },
    });
    expect(res.status).toBe(202);
    const { rows, result } = await runAndRead(res.body.data.id as string);
    expect(result.status).toBe('ready');
    expect(rows[0]?.slice(0, 3)).toEqual(['Report', 'calls', '2026-09-01 – 2026-09-01']);
    expect(rows[1]).toEqual(['Metric', 'Value', 'Previous period']);
    expect(rows.find((r) => r[0] === 'calls_attempted')?.[1]).toBe('4');
  });
});

describe('downloadNameOf', () => {
  it('names files by kind, account and days only', () => {
    expect(
      downloadNameOf(
        { kind: 'calls', format: 'xlsx', filter: { body: { from: '2026-09-01' } } },
        'acme',
      ),
    ).toBe('calls-acme-2026-09-01-now.xlsx');
    expect(
      downloadNameOf(
        { kind: 'report', format: 'csv', filter: { body: { tab: 'team', query: {} } } },
        'acme',
      ),
    ).toBe('report-team-acme-start-now.csv');
    expect(downloadNameOf({ kind: 'report', format: 'csv', filter: {} }, 'acme')).toBe(
      'report-overview-acme-start-now.csv',
    );
  });
});

describe('GET /exports/:id', () => {
  it('returns progress and a download link when ready, scoped by kind and account', async () => {
    const res = await post(manager, 'messages', { from: '2026-09-01', to: '2026-09-02' });
    const id = res.body.data.id as string;
    const pending = await request(app).get(`/api/v1/exports/${id}`).set(auth(manager));
    expect(pending.body.data.status).toBe('pending');
    expect(pending.body.data.downloadUrl).toBeUndefined();
    await runAndRead(id);
    const ready = await request(app).get(`/api/v1/exports/${id}`).set(auth(manager));
    expect(ready.body.data).toMatchObject({ status: 'ready', rowCount: 2 });
    expect(ready.body.data.downloadUrl).toMatch(/^http:\/\/localhost:5100\//);
    const url = new URL(ready.body.data.downloadUrl as string);
    expect(url.searchParams.get('name')).toBe(
      `messages-${t.account.slug}-2026-09-01-2026-09-02.csv`,
    );
    // calls-only people can't see message exports; viewers can't see any
    expect((await request(app).get(`/api/v1/exports/${id}`).set(auth(callsOnly))).status).toBe(404);
    expect((await request(app).get(`/api/v1/exports/${id}`).set(auth(viewer))).status).toBe(403);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect((await request(app).get(`/api/v1/exports/${id}`).set(auth(stranger))).status).toBe(404);
    expect((await request(app).get('/api/v1/exports/nope').set(auth(manager))).status).toBe(422);
  });

  it('lists recent exports of the kinds each person may see — and keeps them out of contact exports', async () => {
    const all = await request(app).get('/api/v1/exports?limit=100').set(auth(manager));
    expect(all.status).toBe(200);
    const kinds = new Set((all.body.data as { kind: string }[]).map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['calls', 'messages', 'report']);
    expect(all.body.meta.total).toBe(all.body.data.length);
    const mine = await request(app).get('/api/v1/exports?limit=100').set(auth(callsOnly));
    expect(new Set((mine.body.data as { kind: string }[]).map((e) => e.kind))).toEqual(
      new Set(['calls']),
    );
    expect((await request(app).get('/api/v1/exports').set(auth(viewer))).status).toBe(403);

    // contacts.export alone never reaches call / message files
    const contactList = await request(app).get('/api/v1/contact-exports').set(auth(manager));
    expect(contactList.body.data).toEqual([]);
    const callExport = (all.body.data as { id: string; kind: string }[]).find(
      (e) => e.kind === 'calls',
    );
    expect(
      (
        await request(app)
          .get(`/api/v1/contact-exports/${callExport?.id ?? ''}`)
          .set(auth(manager))
      ).status,
    ).toBe(404);
  });

  it('skips a job that is no longer pending and fails cleanly without storage', async () => {
    const res = await post(manager, 'calls', { from: '2026-09-01', to: '2026-09-01' });
    const id = res.body.data.id as string;
    const noStorage = await runRecordExport(
      { accountId: t.account._id.toString(), exportJobId: id },
      { logger: deps.logger },
    );
    expect(noStorage).toEqual({ status: 'failed' });
    expect((await ExportJobModel.findById(id).lean())?.errorMessage).toMatch(/try again/);
    expect(
      await runRecordExport({ accountId: t.account._id.toString(), exportJobId: id }, deps),
    ).toEqual({ status: 'skipped' });
  });
});
