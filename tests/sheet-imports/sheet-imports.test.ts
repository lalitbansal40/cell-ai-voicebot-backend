import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { keyMatches, rowFor, verifyRequest } from '../../scripts/lib/sheets-receiver';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ImportJobModel } from '../../src/db/models/import-job.model';
import { SheetImportModel } from '../../src/db/models/sheet-import.model';
import { acquireJobLock, releaseJobLock } from '../../src/modules/contacts/locks';
import { assertSheetUrl, setSheetFetcher } from '../../src/modules/sheet-imports/fetch';
import { queueDueSheetImports, runSheetImport } from '../../src/modules/sheet-imports/run.job';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp, testEnv } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const rec = recordingContactJobs();
const app = buildTestApp({}, { storage, contactJobs: rec.jobs });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const URL_OK =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pub?gid=0&single=true&output=csv';

/** The published sheet the fake Google returns (no network in tests). */
const sheet = {
  body: 'Name,Mobile\nAsha Verma,9876500001\nRavi Kumar,9876500002\n',
  type: 'text/csv',
  error: null as string | null,
};
setSheetFetcher((url) =>
  Promise.resolve(
    sheet.error
      ? {
          ok: false,
          error: sheet.error as never,
          httpStatus: 200,
          contentType: sheet.type,
          body: Buffer.alloc(0),
        }
      : {
          ok: true,
          httpStatus: 200,
          contentType: sheet.type,
          body: Buffer.from(url === URL_OK ? sheet.body : ''),
        },
  ),
);
afterAll(() => {
  setSheetFetcher(null);
});

let a: TestAccount;
let owner: TestUser;
const deps = () => ({ env: testEnv(), storage, logger });

beforeEach(async () => {
  rec.queued.length = 0;
  sheet.body = 'Name,Mobile\nAsha Verma,9876500001\nRavi Kumar,9876500002\n';
  sheet.type = 'text/csv';
  sheet.error = null;
  a = await createTestAccount();
  owner = await a.addUser('owner');
});

const body = (over: Record<string, unknown> = {}) => ({
  name: 'LMS daily',
  url: URL_OK,
  schedule: 'daily',
  mapping: [
    { index: 0, target: 'name' },
    { index: 1, target: 'phone' },
  ],
  ...over,
});
const create = (over: Record<string, unknown> = {}, token = owner.token) =>
  request(app).post('/api/v1/sheet-imports').set(bearer(token)).send(body(over));

describe('published-CSV links', () => {
  it.each([
    [URL_OK, true],
    [
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pub?output=csv',
      true,
    ],
    [
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pub?output=xlsx',
      false,
    ],
    ['https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz/edit#gid=0', false],
    [
      'http://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pub?output=csv',
      false,
    ],
    [
      'https://evil.example.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pub?output=csv',
      false,
    ],
    ['not a link', false],
  ])('%s → %s', (url, ok) => {
    if (ok) expect(() => assertSheetUrl(url)).not.toThrow();
    else
      expect(() => assertSheetUrl(url)).toThrow(
        expect.objectContaining({ code: 'SHEET_URL_INVALID' }),
      );
  });
});

describe('POST /sheet-imports', () => {
  it('checks the sheet now, creates the list, queues the first run (audited, link never returned)', async () => {
    const res = await create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'LMS daily',
      schedule: 'daily',
      listName: 'Google Sheet: LMS daily',
      lastStatus: 'running',
    });
    expect(JSON.stringify(res.body)).not.toContain('2PACX');
    expect(await ContactListModel.countDocuments({ accountId: a.account._id })).toBe(1);
    expect(rec.queued).toEqual([
      {
        name: 'sheets.import',
        data: {
          accountId: a.account._id.toString(),
          sheetImportId: res.body.data.id,
          runKey: expect.any(String),
        },
      },
    ]);
    const list = await request(app).get('/api/v1/sheet-imports').set(bearer(owner.token));
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('docs.google.com');
    const audit = await AuditLogModel.findOne({
      action: 'sheet_import.created',
      'target.id': res.body.data.id,
    }).lean();
    expect(JSON.stringify(audit)).not.toContain('2PACX');
  });

  it.each([
    ['a sign-in page (not published)', { error: 'unsupported_type' }, 'not published as CSV'],
    ['a file that is too big', { error: 'too_large' }, 'larger than an import allows'],
    ['a download error', { error: 'http_404' }, 'could not be downloaded (http_404)'],
  ])('refuses %s', async (_n, state, message) => {
    sheet.error = state.error;
    const res = await create();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHEET_URL_INVALID');
    expect(res.body.error.details[0].message).toContain(message);
  });

  it('refuses mapping errors and new fields, and allows 5 per account', async () => {
    expect((await create({ mapping: [{ index: 0, target: 'name' }] })).status).toBe(422);
    expect(
      (
        await create({
          mapping: [
            { index: 1, target: 'phone' },
            { index: 0, target: 'new_field', key: 'x', label: 'X', type: 'text' },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await create({ url: 'https://example.com/a.csv' })).status).toBe(422);
    for (let i = 0; i < 5; i += 1)
      expect((await create({ name: `s${String(i)}` })).status).toBe(201);
    expect((await create({ name: 'sixth' })).status).toBe(409);
  });

  it('needs contacts.import; other accounts get 404', async () => {
    const viewer = await a.addUser('viewer');
    expect((await create({}, viewer.token)).status).toBe(403);
    const id = (await create()).body.data.id as string;
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    expect(
      (await request(app).delete(`/api/v1/sheet-imports/${id}`).set(bearer(otherOwner.token)))
        .status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/v1/sheet-imports/${id}/run`).set(bearer(otherOwner.token)))
        .status,
    ).toBe(404);
  });
});

describe('POST /sheet-imports/preview', () => {
  it('shows the columns, samples and a suggested mapping without storing anything', async () => {
    const res = await request(app)
      .post('/api/v1/sheet-imports/preview')
      .set(bearer(owner.token))
      .send({ url: URL_OK });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rowCount).toBe(2);
    expect(res.body.data.columns.map((c: { header: string }) => c.header)).toEqual([
      'Name',
      'Mobile',
    ]);
    expect(res.body.data.suggestedMapping).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1, target: 'phone' })]),
    );
    expect(await SheetImportModel.countDocuments({ accountId: a.account._id })).toBe(0);
    const bad = await request(app)
      .post('/api/v1/sheet-imports/preview')
      .set(bearer(owner.token))
      .send({ url: 'https://example.com/a.csv' });
    expect(bad.status).toBe(422);
  });
});

describe('runs', () => {
  it('imports through the file pipeline, then a later run updates existing contacts by phone', async () => {
    const id = (await create()).body.data.id as string;
    const data = { accountId: a.account._id.toString(), sheetImportId: id, runKey: '1' };
    expect(await runSheetImport(deps(), data)).toEqual({ status: 'ok' });
    let row = await SheetImportModel.findById(id).lean();
    expect(row).toMatchObject({
      lastStatus: 'ok',
      lastResult: { rows: 2, created: 2, updated: 0, failed: 0 },
    });
    expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const listId = row?.listId;
    expect(await ContactModel.countDocuments({ accountId: a.account._id, listIds: listId })).toBe(
      2,
    );

    sheet.body = 'Name,Mobile\nAsha V.,9876500001\nbad,12\n';
    expect(await runSheetImport(deps(), { ...data, runKey: '2' })).toEqual({ status: 'ok' });
    row = await SheetImportModel.findById(id).lean();
    expect(row?.lastResult).toMatchObject({ rows: 2, created: 0, updated: 1, failed: 1 });
    expect(
      (await ContactModel.findOne({ accountId: a.account._id, phoneE164: '+919876500001' }).lean())
        ?.name,
    ).toBe('Asha V.');
    expect(await ImportJobModel.countDocuments({ accountId: a.account._id })).toBe(2);
  });

  it('records a failed download and a busy account; once-only imports are not scheduled again', async () => {
    const id = (await create({ schedule: 'once' })).body.data.id as string;
    const data = { accountId: a.account._id.toString(), sheetImportId: id, runKey: '1' };
    await acquireJobLock('import', a.account._id.toString(), 'someone-else');
    expect(await runSheetImport(deps(), data)).toEqual({ status: 'busy' });
    await releaseJobLock('import', a.account._id.toString(), 'someone-else');
    sheet.type = 'text/html';
    sheet.error = 'unsupported_type';
    expect(await runSheetImport(deps(), data)).toEqual({ status: 'failed' });
    const row = await SheetImportModel.findById(id).lean();
    expect(row).toMatchObject({ lastStatus: 'failed', nextRunAt: null });
    expect(row?.lastError).toContain('not published as CSV');
    expect(await runSheetImport({ ...deps(), storage: undefined }, data)).toEqual({
      status: 'failed',
    });
    expect(
      await runSheetImport(deps(), { ...data, sheetImportId: new Types.ObjectId().toString() }),
    ).toEqual({ status: 'missing' });
  });

  it('queues due imports every 15 minutes (never twice; a stuck run after an hour)', async () => {
    const id = (await create()).body.data.id as string;
    rec.queued.length = 0;
    // just created: running → not queued again
    expect(await queueDueSheetImports(rec.jobs)).toEqual({ queued: 0 });
    await SheetImportModel.updateOne(
      { _id: id },
      { $set: { lastStatus: 'ok', nextRunAt: new Date(Date.now() - 1000) } },
    );
    expect(await queueDueSheetImports(rec.jobs)).toEqual({ queued: 1 });
    expect(await queueDueSheetImports(rec.jobs)).toEqual({ queued: 0 });
    await SheetImportModel.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { updatedAt: new Date(Date.now() - 2 * 3_600_000) } },
    );
    expect(await queueDueSheetImports(rec.jobs)).toEqual({ queued: 1 });
  });

  it('run now (202, once at a time) and delete (contacts and list stay)', async () => {
    const id = (await create()).body.data.id as string;
    expect(
      (await request(app).post(`/api/v1/sheet-imports/${id}/run`).set(bearer(owner.token))).status,
    ).toBe(409);
    await SheetImportModel.updateOne({ _id: id }, { $set: { lastStatus: 'ok' } });
    const run = await request(app).post(`/api/v1/sheet-imports/${id}/run`).set(bearer(owner.token));
    expect(run.status).toBe(202);
    expect(run.body.data.lastStatus).toBe('running');
    expect(
      (await request(app).delete(`/api/v1/sheet-imports/${id}`).set(bearer(owner.token))).status,
    ).toBe(204);
    expect(await ContactListModel.countDocuments({ accountId: a.account._id })).toBe(1);
    expect(
      await AuditLogModel.countDocuments({ action: 'sheet_import.deleted', 'target.id': id }),
    ).toBe(1);
  });
});

describe('Apps Script receiver logic (scripts/lib/sheets-receiver.ts)', () => {
  const { vectors } = JSON.parse(
    readFileSync(path.join(__dirname, '../fixtures/webhooks/vectors.json'), 'utf8'),
  ) as { vectors: { secret: string; timestamp: number; body: string; signature: string }[] };
  const hmacHex = (key: string, message: string) =>
    createHmac('sha256', key).update(message).digest('hex');

  it.each(vectors)('verifies the golden vector at ts $timestamp', (v) => {
    const headers = {
      'x-webhook-timestamp': String(v.timestamp),
      'x-webhook-signature': `v1=${v.signature}`,
    };
    expect(
      verifyRequest({ headers, rawBody: v.body, secret: v.secret, nowSec: v.timestamp, hmacHex }),
    ).toBe(true);
    expect(
      verifyRequest({
        headers,
        rawBody: `${v.body}x`,
        secret: v.secret,
        nowSec: v.timestamp,
        hmacHex,
      }),
    ).toBe(false);
    expect(
      verifyRequest({
        headers,
        rawBody: v.body,
        secret: v.secret,
        nowSec: v.timestamp + 301,
        hmacHex,
      }),
    ).toBe(false);
  });

  it('checks the URL key and builds one row per call.completed', () => {
    expect(keyMatches('abc', 'abc')).toBe(true);
    expect(keyMatches('abd', 'abc')).toBe(false);
    expect(keyMatches(undefined, '')).toBe(false);
    const raw = JSON.stringify({
      id: 'evt_1',
      type: 'call.completed',
      data: {
        callId: 'c',
        externalRef: 'loan-1',
        status: 'completed',
        disposition: 'promise_to_pay',
        durationSec: 61,
        costMicros: 2_345_678,
        contactId: 'k',
      },
    });
    expect(rowFor(raw, 'T')).toEqual([
      'T',
      'evt_1',
      'c',
      'loan-1',
      'completed',
      'promise_to_pay',
      61,
      2.35,
      'k',
    ]);
    expect(rowFor(JSON.stringify({ id: 'e', type: 'call.started', data: {} }), 'T')).toBeNull();
    expect(rowFor(JSON.stringify({ id: 'e', type: 'call.completed', data: {} }), 'T')).toEqual([
      'T',
      'e',
      '',
      '',
      '',
      '',
      0,
      0,
      '',
    ]);
  });
});
