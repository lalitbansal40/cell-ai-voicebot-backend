import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ContactListModel } from '../../src/db/models/contact-list.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { ImportJobModel } from '../../src/db/models/import-job.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { borrowerRows, csvBuffer, xlsxBuffer } from '../helpers/import-files';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage, contactJobs: recordingContactJobs().jobs });
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/contact-imports';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let viewer: TestUser;

const upload = (
  u: { token: string },
  buffer: Buffer,
  filename = 'march.csv',
  contentType = 'text/csv',
  kind?: string,
) => {
  const r = request(app).post(URL).set(auth(u)).attach('file', buffer, { filename, contentType });
  return kind ? r.field('kind', kind) : r;
};

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'loan_amount',
    label: 'Loan Amt',
    type: 'currency',
    order: 1,
  });
});

describe('upload', () => {
  it('stores a CSV and returns columns, samples, warnings and a suggested mapping', async () => {
    const res = await upload(manager, csvBuffer(borrowerRows(30), { bom: true }));
    expect(res.status).toBe(201);
    const job = res.body.data;
    expect(job).toMatchObject({
      kind: 'contacts',
      fileName: 'march.csv',
      fileType: 'csv',
      status: 'uploaded',
      rowCount: 30,
      sheet: null,
      sheets: [],
      progress: { processed: 0, total: 30 },
      hasErrorReport: false,
      warnings: [],
      mapping: null,
    });
    expect(job.columns[1]).toEqual({
      index: 1,
      header: 'Mobile No',
      samples: ['9000000000', '9000000001', '9000000002'],
    });
    expect(job.suggestedMapping).toEqual([
      { index: 0, target: 'name' },
      { index: 1, target: 'phone' },
      { index: 2, target: 'field', key: 'loan_amount' },
      {
        index: 3,
        target: 'new_field',
        key: 'due_date',
        label: 'Due Date',
        type: 'date',
        dateFormat: 'DMY',
      },
    ]);
    expect(job).not.toHaveProperty('fileKey');
    const stored = await ImportJobModel.findById(job.id).lean();
    expect(stored?.fileKey).toBe(
      `accounts/${t.account._id.toString()}/imports/${job.id as string}.csv`,
    );
    expect(await storage.exists(stored?.fileKey ?? '')).toBe(true);
  });

  it('accepts xlsx with several sheets', async () => {
    const buffer = await xlsxBuffer([
      { name: 'March', rows: [['Phone'], ['9876543210']] },
      {
        name: 'April',
        rows: [
          ['Name', 'Phone'],
          ['A', '9876543211'],
          ['B', '9876543212'],
        ],
      },
    ]);
    const res = await upload(owner, buffer, 'book.xlsx', XLSX);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fileType: 'xlsx',
      sheet: 'March',
      sheets: ['March', 'April'],
      rowCount: 1,
    });
  });

  it('rejects wrong types (415), large files (413), missing / invalid files (422)', async () => {
    expect(
      (await upload(owner, Buffer.from('x'), 'old.xls', 'application/vnd.ms-excel')).status,
    ).toBe(415);
    const fake = await upload(owner, Buffer.from('phone\n1'), 'fake.xlsx', XLSX);
    expect(fake.status).toBe(415);
    expect(fake.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const big = await upload(owner, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const none = await request(app).post(URL).set(auth(owner)).field('kind', 'contacts');
    expect(none.status).toBe(422);
    expect(none.body.error.details[0].path).toBe('file');
    const empty = await upload(owner, Buffer.from('Name,Phone\n'));
    expect(empty.status).toBe(422);
    expect(empty.body.error).toMatchObject({
      code: 'IMPORT_FILE_INVALID',
      details: [{ path: 'file', message: 'empty_file' }],
    });
    const wrongField = await request(app)
      .post(URL)
      .set(auth(owner))
      .attach('document', Buffer.from('a'), { filename: 'a.csv', contentType: 'text/csv' });
    expect(wrongField.status).toBe(422);
    expect(
      (await upload(owner, csvBuffer(borrowerRows(1)), 'a.csv', 'text/csv', 'everything')).status,
    ).toBe(422);
  });

  it('DND files need contacts.write as well; viewers cannot upload', async () => {
    expect((await upload(viewer, csvBuffer(borrowerRows(1)))).status).toBe(403);
    const roleId = new Types.ObjectId();
    await RoleModel.create({
      _id: roleId,
      accountId: t.account._id,
      key: 'importer',
      name: 'Importer',
      isSystem: false,
      permissions: ['contacts.read', 'contacts.import'],
    });
    const user = await UserModel.create({
      accountId: t.account._id,
      roleId,
      name: 'Importer',
      email: `importer-${roleId.toString()}@example.com`,
      status: 'active',
      emailVerifiedAt: new Date(),
    });
    const importer = { token: await tokenFor(user) };
    expect(
      (await upload(importer, csvBuffer([['Phone'], ['9876543210']]), 'dnd.csv', 'text/csv', 'dnd'))
        .status,
    ).toBe(403);
    const dnd = await upload(
      manager,
      csvBuffer([
        ['Mobile', 'Remarks'],
        ['9876543210', 'asked'],
      ]),
      'dnd.csv',
      'text/csv',
      'dnd',
    );
    expect(dnd.status).toBe(201);
    expect(dnd.body.data.suggestedMapping).toEqual([
      { index: 0, target: 'phone' },
      { index: 1, target: 'reason' },
    ]);
  });
});

describe('mapping, cancel, history, template, error report', () => {
  let jobId: string;
  const columns = [
    { index: 0, target: 'name' },
    { index: 1, target: 'phone' },
    { index: 2, target: 'field', key: 'loan_amount' },
    {
      index: 3,
      target: 'new_field',
      key: 'due_date',
      label: 'Due date',
      type: 'date',
      dateFormat: 'DMY',
    },
  ];

  beforeAll(async () => {
    jobId = (await upload(owner, csvBuffer(borrowerRows(5)), 'March Batch.csv')).body.data
      .id as string;
  });

  it('saves a valid mapping with a default new-list option', async () => {
    const res = await request(app)
      .put(`${URL}/${jobId}/mapping`)
      .set(auth(manager))
      .send({ columns });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('mapped');
    expect(res.body.data.mapping).toEqual({ columns });
    expect(res.body.data.options).toMatchObject({
      list: { mode: 'new' },
      updateExisting: true,
      tags: [],
      consentSource: null,
    });
    expect(res.body.data.options.list.name).toMatch(/^March Batch \d{4}-\d{2}-\d{2}$/);
  });

  it('validates mapping and options', async () => {
    const list = await ContactListModel.create({
      accountId: t.account._id,
      name: 'Taken',
      source: { type: 'manual' },
    });
    const cases: [object, string][] = [
      [{ columns: [{ index: 0, target: 'name' }] }, 'columns'],
      [
        { columns, options: { list: { mode: 'new', name: 'taken' }, tags: [] } },
        'options.list.name',
      ],
      [
        { columns, options: { list: { mode: 'existing', listId: 'a'.repeat(24) } } },
        'options.list.listId',
      ],
      [{ columns, options: { list: { mode: 'new', name: 'X' }, tags: ['bad#'] } }, 'options.tags'],
      [{ columns, sheet: 'Sheet2' }, 'sheet'],
    ];
    for (const [body, path] of cases) {
      const res = await request(app).put(`${URL}/${jobId}/mapping`).set(auth(owner)).send(body);
      expect(res.status, path).toBe(422);
      expect(
        (res.body.error.details as { path: string }[]).map((d) => d.path),
        path,
      ).toContain(path);
    }
    const existing = await request(app)
      .put(`${URL}/${jobId}/mapping`)
      .set(auth(owner))
      .send({
        columns,
        options: {
          list: { mode: 'existing', listId: list._id.toString() },
          updateExisting: false,
          tags: ['VIP'],
          consentSource: 'Loan agreement',
        },
      });
    expect(existing.body.data.options).toEqual({
      list: { mode: 'existing', listId: list._id.toString() },
      updateExisting: false,
      tags: ['vip'],
      consentSource: 'Loan agreement',
    });
  });

  it('switches xlsx sheets when mapping', async () => {
    const buffer = await xlsxBuffer([
      { name: 'March', rows: [['Phone'], ['9876543210']] },
      {
        name: 'April',
        rows: [
          ['Name', 'Phone'],
          ['A', '9876543211'],
          ['B', '9876543212'],
        ],
      },
    ]);
    const id = (await upload(owner, buffer, 'book.xlsx', XLSX)).body.data.id as string;
    const res = await request(app)
      .put(`${URL}/${id}/mapping`)
      .set(auth(owner))
      .send({
        sheet: 'April',
        columns: [
          { index: 0, target: 'name' },
          { index: 1, target: 'phone' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sheet: 'April', rowCount: 2, progress: { total: 2 } });
    expect(res.body.data.columns.map((c: { header: string }) => c.header)).toEqual([
      'Name',
      'Phone',
    ]);
    const missing = await request(app)
      .put(`${URL}/${id}/mapping`)
      .set(auth(owner))
      .send({ sheet: 'May', columns: [{ index: 0, target: 'phone' }] });
    expect(missing.body.error.code).toBe('IMPORT_FILE_INVALID');
  });

  it('cancels before importing (file deleted, samples cleared) and refuses changes afterwards', async () => {
    const id = (await upload(owner, csvBuffer(borrowerRows(2)))).body.data.id as string;
    const key = (await ImportJobModel.findById(id).lean())?.fileKey ?? '';
    const res = await request(app).post(`${URL}/${id}/cancel`).set(auth(owner));
    expect(res.body.data).toMatchObject({ status: 'canceled' });
    expect(res.body.data.columns[0].samples).toEqual([]);
    expect(await storage.exists(key)).toBe(false);
    expect((await request(app).post(`${URL}/${id}/cancel`).set(auth(owner))).status).toBe(409);
    expect(
      (await request(app).put(`${URL}/${id}/mapping`).set(auth(owner)).send({ columns })).status,
    ).toBe(409);
    expect((await request(app).get(`${URL}/${id}`).set(auth(owner))).body.data).not.toHaveProperty(
      'suggestedMapping',
    );
  });

  it('asks a running import to stop', async () => {
    const id = (await upload(owner, csvBuffer(borrowerRows(2)))).body.data.id as string;
    await ImportJobModel.updateOne({ _id: id }, { $set: { status: 'importing' } });
    const res = await request(app).post(`${URL}/${id}/cancel`).set(auth(owner));
    expect(res.body.data.status).toBe('importing');
    expect((await ImportJobModel.findById(id).lean())?.cancelRequested).toBe(true);
    await ImportJobModel.updateOne({ _id: id }, { $set: { status: 'validating' } });
    expect((await request(app).post(`${URL}/${id}/cancel`).set(auth(owner))).status).toBe(409);
  });

  it('lists history with filters and paginates', async () => {
    const res = await request(app).get(`${URL}?kind=dnd`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).not.toHaveProperty('suggestedMapping');
    const all = await request(app).get(`${URL}?limit=2`).set(auth(viewer));
    expect(all.body.meta.totalPages).toBeGreaterThan(1);
    expect(
      (await request(app).get(`${URL}?status=canceled`).set(auth(viewer))).body.meta.total,
    ).toBe(1);
    expect((await request(app).get(`${URL}?status=paused`).set(auth(viewer))).status).toBe(422);
  });

  it('serves a CSV template with every field', async () => {
    await CustomFieldModel.insertMany([
      { accountId: t.account._id, key: 'due_date', label: 'Due', type: 'date', order: 2 },
      { accountId: t.account._id, key: 'dpd', label: 'DPD', type: 'number', order: 3 },
      { accountId: t.account._id, key: 'alt_phone', label: 'Alt', type: 'phone', order: 4 },
      { accountId: t.account._id, key: 'note', label: 'Note, long', type: 'text', order: 5 },
    ]);
    const res = await request(app).get(`${URL}/template.csv`).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('contacts-template.csv');
    expect(res.text).toBe(
      '﻿name,phone,email,external_id,tags,loan_amount,due_date,dpd,alt_phone,note\r\n' +
        'Asha Verma,+919876543210,asha@example.com,LN-1001,vip,12500.00,2026-10-05,30,+919876543211,Sample\r\n',
    );
    expect((await request(app).get(`${URL}/template.csv`).set(auth(viewer))).status).toBe(403);
  });

  it('error report: 404 without one, signed URL with one', async () => {
    expect((await request(app).get(`${URL}/${jobId}/error-report`).set(auth(owner))).status).toBe(
      404,
    );
    const key = `accounts/${t.account._id.toString()}/import-reports/${jobId}.csv`;
    await storage.put(key, Buffer.from('row,reasons\n'), { contentType: 'text/csv' });
    await ImportJobModel.updateOne({ _id: jobId }, { $set: { errorReportKey: key } });
    const res = await request(app).get(`${URL}/${jobId}/error-report`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.expiresInSec).toBe(900);
    expect(res.body.data.url).toContain('/files/accounts/');
    expect(
      (await request(app).get(`${URL}/${jobId}`).set(auth(viewer))).body.data.hasErrorReport,
    ).toBe(true);
  });

  it('isolates accounts and blocks suspended ones', async () => {
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    for (const r of [
      request(app).get(`${URL}/${jobId}`).set(auth(otherOwner)),
      request(app).put(`${URL}/${jobId}/mapping`).set(auth(otherOwner)).send({ columns }),
      request(app).post(`${URL}/${jobId}/cancel`).set(auth(otherOwner)),
      request(app).get(`${URL}/${jobId}/error-report`).set(auth(otherOwner)),
    ]) {
      expect((await r).status).toBe(404);
    }
    expect((await request(app).get(URL).set(auth(otherOwner))).body.meta.total).toBe(0);
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect((await upload(so, csvBuffer(borrowerRows(1)))).status).toBe(403);
  });
});
