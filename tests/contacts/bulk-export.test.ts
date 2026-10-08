import type { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { runExport } from '../../src/modules/contact-exports/export.job';
import { readStoredFile } from '../../src/modules/contact-imports/storage-io';
import { bulkJob } from '../../src/modules/contacts/bulk.service';
import { acquireJobLock, releaseJobLock } from '../../src/modules/contacts/locks';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const rec = recordingContactJobs();
const app = buildTestApp({}, { storage, contactJobs: rec.jobs });
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const deps = { storage, logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }) };

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let agent: TestUser;
let viewer: TestUser;
let list: Types.ObjectId;

const add = (phone: string, extra: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId: t.account._id,
    phoneE164: phone,
    source: { type: 'manual' },
    ...extra,
  });
const bulk = (u: { token: string }, body: object) =>
  request(app).post('/api/v1/contacts/bulk').set(auth(u)).send(body);

afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  agent = await t.addUser('agent');
  viewer = await t.addUser('viewer');
  list = (
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'March',
      source: { type: 'manual' },
    })
  )._id;
  await CustomFieldModel.insertMany([
    { accountId: t.account._id, key: 'loan_amount', label: 'Loan', type: 'currency', order: 1 },
    { accountId: t.account._id, key: 'due_date', label: 'Due', type: 'date', order: 2 },
    { accountId: t.account._id, key: 'alt_phone', label: 'Alt', type: 'phone', order: 3 },
  ]);
});

describe('bulk by ids', () => {
  it('adds / removes tags (capped at 20), lists (capped at 50), deletes and adds to DND', async () => {
    const a = await add('+919000500001', { tags: Array.from({ length: 19 }, (_, i) => `t${i}`) });
    const b = await add('+919000500002', { listIds: Array.from({ length: 50 }, () => list) });
    const ids = [a._id.toString(), b._id.toString()];

    const tagged = await bulk(manager, {
      action: 'add_tags',
      ids,
      payload: { tags: ['VIP', 'Hot'] },
    });
    expect(tagged.status).toBe(200);
    expect(tagged.body.data).toEqual({ count: 1 }); // a would exceed 20 tags → skipped
    expect((await ContactModel.findById(a._id).lean())?.tags).toHaveLength(19);
    const again = await bulk(manager, { action: 'add_tags', ids, payload: { tags: ['vip'] } });
    expect(again.body.data).toEqual({ count: 1 }); // a reaches exactly 20; b already has it
    expect((await ContactModel.findById(a._id).lean())?.tags).toHaveLength(20);
    expect((await ContactModel.findById(b._id).lean())?.tags.sort()).toEqual(['hot', 'vip']);

    expect(
      (await bulk(manager, { action: 'remove_tags', ids, payload: { tags: ['vip'] } })).body.data
        .count,
    ).toBe(2);
    const other = await ContactListModel.create({
      accountId: t.account._id,
      name: 'April',
      source: { type: 'manual' },
    });
    expect(
      (
        await bulk(manager, {
          action: 'add_to_list',
          ids,
          payload: { listId: other._id.toString() },
        })
      ).body.data.count,
    ).toBe(1); // b already has 50 lists
    expect(
      (
        await bulk(manager, {
          action: 'remove_from_list',
          ids,
          payload: { listId: other._id.toString() },
        })
      ).body.data.count,
    ).toBe(1);
    expect(
      (await bulk(manager, { action: 'add_to_dnd', ids, payload: { reason: 'asked' } })).body.data
        .count,
    ).toBe(2);
    expect(
      await DndEntryModel.countDocuments({
        accountId: t.account._id,
        phoneE164: { $in: ['+919000500001', '+919000500002'] },
      }),
    ).toBe(2);
    expect((await ContactModel.findById(a._id).lean())?.dnd).toBe(true);

    expect((await bulk(owner, { action: 'delete', ids })).body.data.count).toBe(2);
    expect(await ContactModel.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(0);
    const audit = await AuditLogModel.find({ accountId: t.account._id }).sort({ at: 1 }).lean();
    expect(audit.map((x) => [x.action, x.meta])).toEqual(
      expect.arrayContaining([
        ['contacts.bulk_updated', { action: 'add_tags', count: 1, mode: 'ids' }],
        ['dnd.added', { count: 2, source: 'manual' }],
        ['contacts.deleted', { count: 2, mode: 'ids' }],
      ]),
    );
  });

  it('validates the request and refuses contacts of other accounts', async () => {
    const c = await add('+919000500003');
    const id = c._id.toString();
    for (const body of [
      { action: 'add_tags', ids: [id] },
      { action: 'add_tags', ids: [id], payload: { tags: ['bad#'] } },
      { action: 'add_to_list', ids: [id], payload: {} },
      { action: 'add_to_list', ids: [id], payload: { listId: 'a'.repeat(24) } },
      { action: 'delete' },
      { action: 'delete', ids: [id], filter: {} },
      { action: 'explode', ids: [id] },
    ]) {
      expect((await bulk(owner, body)).status, JSON.stringify(body)).toBe(422);
    }
    const other = await createTestAccount();
    const theirs = await ContactModel.create({
      accountId: other.account._id,
      phoneE164: '+919000500003',
      source: { type: 'manual' },
    });
    expect((await bulk(owner, { action: 'delete', ids: [id, theirs._id.toString()] })).status).toBe(
      404,
    );
    expect((await bulk(agent, { action: 'delete', ids: [id] })).status).toBe(403);
  });
});

describe('bulk by filter', () => {
  it('queues a job (202) that applies the action in batches and reports back', async () => {
    await add('+919000600001', { tags: ['batch'] });
    await add('+919000600002', { tags: ['batch'] });
    rec.queued.length = 0;
    const res = await bulk(manager, {
      action: 'add_to_list',
      filter: { tags: { mode: 'any', values: ['batch'] } },
      payload: { listId: list.toString() },
    });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ jobQueued: true, count: 2 });
    const queued = rec.queued[0];
    expect(queued?.name).toBe('bulk.run');
    // a second filter-based action waits for the first
    expect((await bulk(manager, { action: 'delete', filter: {} })).status).toBe(409);
    expect(await bulkJob(queued?.data as never)).toEqual({ count: 2 });
    expect(
      await ContactModel.countDocuments({ accountId: t.account._id, listIds: list, tags: 'batch' }),
    ).toBe(2);
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      'meta.mode': 'filter',
    }).lean();
    expect(audit?.meta).toEqual({ action: 'add_to_list', count: 2, mode: 'filter' });
    expect(
      (
        await bulk(manager, {
          action: 'remove_tags',
          filter: { tags: { mode: 'any', values: ['batch'] } },
          payload: { tags: ['batch'] },
        })
      ).status,
    ).toBe(202);
    await bulkJob(rec.queued[1]?.data as never);
  });

  it('a filter broken meanwhile matches nothing; too many matches → 409; enqueue failure frees the lock', async () => {
    expect(
      await bulkJob({
        accountId: t.account._id.toString(),
        actorUserId: owner.user._id.toString(),
        action: 'delete',
        filter: { conditions: [{ key: 'gone', op: 'exists' }] },
        payload: {},
      }),
    ).toEqual({ count: 0 });
    vi.spyOn(ContactModel, 'countDocuments').mockResolvedValueOnce(100_001);
    expect((await bulk(owner, { action: 'delete', filter: {} })).status).toBe(409);
    const failing = buildTestApp(
      {},
      { storage, contactJobs: { enqueue: () => Promise.reject(new Error('down')) } },
    );
    expect(
      (
        await request(failing)
          .post('/api/v1/contacts/bulk')
          .set(auth(owner))
          .send({ action: 'delete', filter: { q: 'nobody' } })
      ).status,
    ).toBe(500);
    expect(await acquireJobLock('bulk', t.account._id.toString(), 'probe')).toBe(true);
    await releaseJobLock('bulk', t.account._id.toString(), 'probe');
  });
});

describe('export', () => {
  let exportAccount: TestAccount;
  let eo: TestUser;

  beforeAll(async () => {
    exportAccount = await createTestAccount();
    eo = await exportAccount.addUser('owner');
    const a = exportAccount.account._id;
    await CustomFieldModel.insertMany([
      { accountId: a, key: 'loan_amount', label: 'Loan', type: 'currency', order: 1 },
      { accountId: a, key: 'due_date', label: 'Due', type: 'date', order: 2 },
      { accountId: a, key: 'alt_phone', label: 'Alt', type: 'phone', order: 3 },
      { accountId: a, key: 'note', label: 'Note', type: 'text', order: 4 },
    ]);
    const l = await ContactListModel.create({
      accountId: a,
      name: 'March',
      source: { type: 'manual' },
    });
    await ContactModel.create({
      accountId: a,
      phoneE164: '+919000700001',
      name: '=HYPERLINK("http://evil")',
      email: 'asha@example.com',
      externalId: 'LN-1',
      tags: ['vip', 'overdue'],
      listIds: [l._id],
      dnd: true,
      optedOutAt: new Date(),
      consent: { source: 'Loan agreement', at: new Date('2026-10-01T00:00:00Z') },
      variables: {
        loan_amount: 12_500_100_000,
        due_date: '2026-10-05',
        alt_phone: '+919000700002',
        note: '@SUM(1)',
      },
      source: { type: 'manual' },
    });
    await ContactModel.create({
      accountId: a,
      phoneE164: '+919000700003',
      name: 'Ravi',
      source: { type: 'manual' },
    });
  });

  const exportReq = (body: object, u: { token: string } = eo) =>
    request(app).post('/api/v1/contact-exports').set(auth(u)).send(body);

  it('writes an injection-safe CSV with formatted values and gives a signed link', async () => {
    rec.queued.length = 0;
    const res = await exportReq({ scope: 'filter', filter: {} });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      progress: { total: 2 },
      scope: 'filter',
    });
    const id = res.body.data.id as string;
    expect(rec.queued).toEqual([
      {
        name: 'export.run',
        data: { accountId: exportAccount.account._id.toString(), exportJobId: id },
      },
    ]);
    expect(
      await runExport({ accountId: exportAccount.account._id.toString(), exportJobId: id }, deps),
    ).toEqual({ status: 'ready', rows: 2 });

    const job = await ExportJobModel.findById(id).lean();
    const csv = (await readStoredFile(storage, job?.fileKey ?? '')).toString('utf8');
    const [header, first, second] = csv.split('\r\n');
    expect(header).toBe(
      '﻿name,phone,email,external_id,tags,lists,dnd,opted_out,consent_source,consent_at,created_at,loan_amount,due_date,alt_phone,note',
    );
    expect(first).toContain(
      `"'=HYPERLINK(""http://evil"")",+919000700001,asha@example.com,LN-1,"vip, overdue",March,yes,yes,Loan agreement,2026-10-01T00:00:00.000Z,`,
    );
    expect(first).toMatch(/,12500\.10,2026-10-05,\+919000700002,'@SUM\(1\)$/);
    expect(second).toMatch(/^Ravi,\+919000700003,,,,,no,no,,,/);

    const got = await request(app).get(`/api/v1/contact-exports/${id}`).set(auth(eo));
    expect(got.body.data).toMatchObject({ status: 'ready', rowCount: 2 });
    expect(got.body.data.downloadUrl).toContain('/files/accounts/');
    const audit = await AuditLogModel.findOne({
      accountId: exportAccount.account._id,
      action: 'contacts.exported',
    }).lean();
    expect(audit?.meta).toEqual({ scope: 'filter', rows: 2 });
    const history = await request(app).get('/api/v1/contact-exports').set(auth(eo));
    expect(history.body.meta.total).toBe(1);
    expect(history.body.data[0]).not.toHaveProperty('downloadUrl');
  });

  it('supports ids, list and segment scopes and chosen columns', async () => {
    const a = exportAccount.account._id;
    const contact = await ContactModel.findOne({ accountId: a, phoneE164: '+919000700003' }).lean();
    const l = await ContactListModel.findOne({ accountId: a, name: 'March' }).lean();
    const s = await SegmentModel.create({
      accountId: a,
      name: 'VIP',
      filter: { tags: { mode: 'any', values: ['vip'] } },
      createdBy: eo.user._id,
    });
    const acc = a.toString();
    const ids = await exportReq({
      scope: 'ids',
      ids: [contact?._id.toString()],
      columns: ['phone', 'name', 'phone'],
    });
    await runExport({ accountId: acc, exportJobId: ids.body.data.id as string }, deps);
    const idsJob = await ExportJobModel.findById(ids.body.data.id).lean();
    expect(idsJob?.columns).toEqual(['phone', 'name']);
    expect((await readStoredFile(storage, idsJob?.fileKey ?? '')).toString()).toBe(
      '﻿phone,name\r\n+919000700003,Ravi\r\n',
    );
    for (const body of [
      { scope: 'list', listId: l?._id.toString() },
      { scope: 'segment', segmentId: s._id.toString() },
    ]) {
      const res = await exportReq(body);
      expect(res.body.data.progress.total).toBe(1);
      await runExport({ accountId: acc, exportJobId: res.body.data.id as string }, deps);
    }
  });

  it('validates scopes / columns, limits size, guards locks, permissions and impersonation', async () => {
    for (const body of [
      { scope: 'ids' },
      { scope: 'list' },
      { scope: 'filter', filter: {}, columns: ['nope'] },
      { scope: 'filter', filter: { conditions: [{ key: 'nope', op: 'exists' }] } },
    ]) {
      expect((await exportReq(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await exportReq({ scope: 'ids', ids: ['a'.repeat(24)] })).status).toBe(404);
    expect((await exportReq({ scope: 'list', listId: 'a'.repeat(24) })).status).toBe(404);
    expect((await exportReq({ scope: 'segment', segmentId: 'a'.repeat(24) })).status).toBe(404);
    vi.spyOn(ContactModel, 'countDocuments').mockResolvedValueOnce(100_001);
    expect((await exportReq({ scope: 'filter', filter: {} })).status).toBe(409);

    await exportReq({ scope: 'filter', filter: {} }); // holds the lock (not run)
    expect((await exportReq({ scope: 'filter', filter: {} })).status).toBe(409);
    await releaseJobLock(
      'export',
      exportAccount.account._id.toString(),
      (await ExportJobModel.findOne({ status: 'pending' }).lean())?._id.toString() ?? '',
    );

    const failing = buildTestApp(
      {},
      { storage, contactJobs: { enqueue: () => Promise.reject(new Error('down')) } },
    );
    const pendingBefore = await ExportJobModel.countDocuments({ status: 'pending' });
    expect(
      (
        await request(failing)
          .post('/api/v1/contact-exports')
          .set(auth(eo))
          .send({ scope: 'filter', filter: {} })
      ).status,
    ).toBe(500);
    expect(await ExportJobModel.countDocuments({ status: 'pending' })).toBe(pendingBefore);

    expect((await exportReq({ scope: 'filter', filter: {} }, viewer)).status).toBe(403);
    expect((await exportReq({ scope: 'filter', filter: {} }, manager)).status).toBe(202); // manager has contacts.export
    const imp = { token: await tokenFor(eo.user, { imp: 'b'.repeat(24) }) };
    const blocked = await exportReq({ scope: 'filter', filter: {} }, imp);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
  });

  it('expired exports have no link; failures and repeats are handled', async () => {
    const acc = exportAccount.account._id.toString();
    await releaseJobLock(
      'export',
      acc,
      (
        await ExportJobModel.findOne({
          accountId: exportAccount.account._id,
          status: 'pending',
        }).lean()
      )?._id.toString() ?? '',
    );
    const res = await exportReq({ scope: 'filter', filter: {} });
    const id = res.body.data.id as string;
    await runExport({ accountId: acc, exportJobId: id }, deps);
    expect(await runExport({ accountId: acc, exportJobId: id }, deps)).toEqual({
      status: 'skipped',
    });
    await ExportJobModel.updateOne(
      { _id: id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(
      (await request(app).get(`/api/v1/contact-exports/${id}`).set(auth(eo))).body.data,
    ).not.toHaveProperty('downloadUrl');

    const failed = await exportReq({ scope: 'filter', filter: {} });
    vi.spyOn(ContactModel, 'find').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    expect(
      await runExport({ accountId: acc, exportJobId: failed.body.data.id as string }, deps),
    ).toEqual({ status: 'failed' });
    expect((await ExportJobModel.findById(failed.body.data.id).lean())?.errorMessage).toContain(
      'try again',
    );

    const big = await exportReq({ scope: 'filter', filter: {} });
    vi.spyOn(ContactModel, 'countDocuments').mockResolvedValueOnce(100_001);
    await runExport({ accountId: acc, exportJobId: big.body.data.id as string }, deps);
    expect((await ExportJobModel.findById(big.body.data.id).lean())?.errorMessage).toContain(
      'narrow',
    );

    const other = await createTestAccount();
    const oo = await other.addUser('owner');
    expect((await request(app).get(`/api/v1/contact-exports/${id}`).set(auth(oo))).status).toBe(
      404,
    );
  });
});
