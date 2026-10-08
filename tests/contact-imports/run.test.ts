import { readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SAMPLE_DND_PHONES, SAMPLE_EXISTING_PHONES } from '../../scripts/make-contact-samples';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { ImportJobModel } from '../../src/db/models/import-job.model';
import { runImport } from '../../src/modules/contact-imports/run.job';
import { validateImport } from '../../src/modules/contact-imports/validate.job';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { borrowerRows, csvBuffer } from '../helpers/import-files';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const rec = recordingContactJobs();
const app = buildTestApp({}, { storage, contactJobs: rec.jobs });
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/contact-imports';
const deps = { storage, logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }) };
const SAMPLE = readFileSync(path.resolve(__dirname, '../../docs/samples/contacts-sample-100.csv'));
const DND_SAMPLE = readFileSync(path.resolve(__dirname, '../../docs/samples/dnd-sample.csv'));

afterEach(() => vi.restoreAllMocks());

/** A fresh account with the sample's preconditions (required loan_amount, 2 existing, 2 on DND). */
const setupAccount = async () => {
  const t = await createTestAccount();
  const owner = await t.addUser('owner');
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'loan_amount',
    label: 'Loan Amount',
    type: 'currency',
    required: true,
    order: 1,
  });
  for (const phone of SAMPLE_EXISTING_PHONES) {
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: phone,
      name: 'Old Name',
      source: { type: 'manual' },
      variables: { loan_amount: 1_000_000 },
      tags: ['old'],
    });
  }
  for (const phone of SAMPLE_DND_PHONES) {
    await DndEntryModel.create({ accountId: t.account._id, phoneE164: phone, source: 'manual' });
  }
  return { t, owner };
};

/** upload → map (suggested, optional overrides) → validate → start; returns the job id. */
const readyToRun = async (
  owner: TestUser,
  accountId: string,
  file: Buffer = SAMPLE,
  { kind = 'contacts', options }: { kind?: string; options?: object } = {},
) => {
  const up = await request(app)
    .post(URL)
    .set(auth(owner))
    .field('kind', kind)
    .attach('file', file, { filename: 'march.csv', contentType: 'text/csv' });
  const id = up.body.data.id as string;
  const mapped = await request(app)
    .put(`${URL}/${id}/mapping`)
    .set(auth(owner))
    .send({ columns: up.body.data.suggestedMapping, ...(options ? { options } : {}) });
  expect(mapped.status).toBe(200);
  await request(app).post(`${URL}/${id}/validate`).set(auth(owner));
  expect((await validateImport({ accountId, importJobId: id }, deps)).status).toBe('validated');
  rec.queued.length = 0;
  const started = await request(app).post(`${URL}/${id}/start`).set(auth(owner));
  expect(started.status).toBe(202);
  expect(started.body.data.status).toBe('importing');
  expect(rec.queued).toEqual([{ name: 'import.run', data: { accountId, importJobId: id } }]);
  return id;
};

describe('import run — the 100-row sample', () => {
  let t: TestAccount;
  let owner: TestUser;
  let id: string;

  beforeAll(async () => {
    ({ t, owner } = await setupAccount());
    id = await readyToRun(owner, t.account._id.toString(), SAMPLE, {
      options: {
        list: { mode: 'new', name: 'March borrowers' },
        tags: ['March'],
        consentSource: 'Loan agreement',
      },
    });
    expect(
      (await runImport({ accountId: t.account._id.toString(), importJobId: id }, deps)).status,
    ).toBe('completed');
  });

  it('imports with the exact totals and creates the mapped fields', async () => {
    const job = await request(app).get(`${URL}/${id}`).set(auth(owner));
    expect(job.body.data).toMatchObject({
      status: 'completed',
      progress: { processed: 100, total: 100 },
      totals: {
        rows: 100,
        created: 87,
        updated: 2,
        unchanged: 0,
        invalid: 8,
        duplicates: 3,
        dnd: 2,
      },
    });
    expect(job.body.data.completedAt).toBeTruthy();
    const keys = (
      await CustomFieldModel.find({ accountId: t.account._id }).sort({ order: 1 }).lean()
    ).map((f) => [f.key, f.type]);
    expect(keys).toEqual(
      [
        ['loan_amount', 'currency'],
        ['email_value', 'text'],
        ['due_date', 'date'],
        ['dpd', 'number'],
        ['branch', 'text'],
      ].filter(([k]) => k !== 'email_value'),
    );
    expect(await ContactModel.countDocuments({ accountId: t.account._id })).toBe(89);
  });

  it('stores typed variables, tags, list, consent and source', async () => {
    const c = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919000100001',
    }).lean();
    const list = await ContactListModel.findOne({
      accountId: t.account._id,
      name: 'March borrowers',
    }).lean();
    expect(c).toMatchObject({
      name: 'Test Borrower 001',
      externalId: 'LN-0001',
      variables: { loan_amount: 5_250_000_000, due_date: '2026-02-02', dpd: 7, branch: 'Mumbai' },
      tags: ['march'],
      dnd: false,
      source: { type: 'import' },
    });
    expect(c?.source.importJobId?.toString()).toBe(id);
    expect(c?.listIds.map(String)).toEqual([list?._id.toString()]);
    expect(c?.consent?.source).toBe('Loan agreement');
    expect(list?.source).toMatchObject({ type: 'upload', fileName: 'march.csv' });
    const vip = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919000100010',
    }).lean();
    expect(vip?.tags.sort()).toEqual(['march', 'vip']);
    expect(
      await ContactModel.countDocuments({ accountId: t.account._id, listIds: list?._id }),
    ).toBe(89);
  });

  it('merges existing contacts and flags DND numbers', async () => {
    const existing = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: SAMPLE_EXISTING_PHONES[0],
    }).lean();
    expect(existing).toMatchObject({ name: 'Test Borrower 086', tags: ['old', 'march'] });
    expect((existing?.variables as unknown as Record<string, number>).loan_amount).toBe(
      26_500_000_000,
    );
    const flagged = await ContactModel.find({ accountId: t.account._id, dnd: true }).lean();
    expect(flagged.map((c) => c.phoneE164).sort()).toEqual([...SAMPLE_DND_PHONES].sort());
  });

  it('audits start and completion (counts only)', async () => {
    const started = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'contacts.import_started',
    }).lean();
    expect(started?.meta).toEqual({ kind: 'contacts', rows: 100 });
    const done = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'contacts.import_completed',
    }).lean();
    expect(done?.meta).toMatchObject({ kind: 'contacts', created: 87, updated: 2, invalid: 8 });
    expect(JSON.stringify(done?.meta)).not.toContain('9000');
  });
});

describe('import run — options and edge cases', () => {
  it('updateExisting off: existing contacts stay unchanged but join the list; empty cells keep values', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const list = await ContactListModel.create({
      accountId: t.account._id,
      name: 'Existing',
      source: { type: 'manual' },
    });
    const id = await readyToRun(owner, acc, SAMPLE, {
      options: {
        list: { mode: 'existing', listId: list._id.toString() },
        updateExisting: false,
        tags: [],
      },
    });
    await runImport({ accountId: acc, importJobId: id }, deps);
    const job = await ImportJobModel.findById(id).lean();
    expect(job?.totals).toMatchObject({ created: 87, updated: 0, unchanged: 2 });
    const old = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: SAMPLE_EXISTING_PHONES[0],
    }).lean();
    expect(old).toMatchObject({
      name: 'Old Name',
      tags: ['old'],
      variables: { loan_amount: 1_000_000 },
    });
    expect(old?.listIds.map(String)).toEqual([list._id.toString()]);

    // second file: only phone + name → other values are kept
    const id2 = await readyToRun(
      owner,
      acc,
      csvBuffer([
        ['Mobile', 'Name'],
        ['9000100001', 'Renamed'],
      ]),
      {
        options: {
          list: { mode: 'existing', listId: list._id.toString() },
          updateExisting: true,
          tags: [],
        },
      },
    );
    await runImport({ accountId: acc, importJobId: id2 }, deps);
    const c = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919000100001',
    }).lean();
    expect(c).toMatchObject({ name: 'Renamed', variables: { loan_amount: 5_250_000_000 } });
  });

  it('an opted-out contact stays opted out and on the DND list after a re-import; deleted phones are revived', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000100002',
      source: { type: 'manual' },
      variables: { loan_amount: 1 },
      optedOutAt: new Date(),
      dnd: true,
    });
    await DndEntryModel.create({
      accountId: t.account._id,
      phoneE164: '+919000100002',
      source: 'manual',
      reason: 'Opted out',
    });
    const gone = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000100003',
      source: { type: 'manual' },
      variables: { loan_amount: 1 },
      deletedAt: new Date(),
    });
    const id = await readyToRun(owner, acc);
    await runImport({ accountId: acc, importJobId: id }, deps);
    const opted = await ContactModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919000100002',
    }).lean();
    expect(opted?.optedOutAt).toBeTruthy();
    expect(opted?.dnd).toBe(true);
    const revived = await ContactModel.findById(gone._id).lean();
    expect(revived).toMatchObject({
      deletedAt: null,
      name: 'Test Borrower 003',
      source: { type: 'import' },
    });
  });

  it('resumes from the checkpoint after a crash (no duplicates) and fails on the last attempt', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const rows = borrowerRows(1200).map((r, i) =>
      i === 0 ? ['Name', 'Mobile No', 'Loan Amount', 'Due Date'] : r,
    );
    const id = await readyToRun(owner, acc, csvBuffer(rows));
    const real = ContactModel.bulkWrite.bind(ContactModel);
    let calls = 0;
    vi.spyOn(ContactModel, 'bulkWrite').mockImplementation(((ops: never, opts: never) => {
      calls += 1;
      if (calls === 3) return Promise.reject(new Error('mongo hiccup'));
      return real(ops, opts);
    }) as never);
    await expect(
      runImport({ accountId: acc, importJobId: id }, deps, {
        attemptsMade: 0,
        opts: { attempts: 3 },
      }),
    ).rejects.toThrow('mongo hiccup');
    expect((await ImportJobModel.findById(id).lean())?.progress.processed).toBe(1000);
    expect(
      (
        await runImport({ accountId: acc, importJobId: id }, deps, {
          attemptsMade: 1,
          opts: { attempts: 3 },
        })
      ).status,
    ).toBe('completed');
    expect(
      await ContactModel.countDocuments({ accountId: t.account._id, 'source.importJobId': id }),
    ).toBe(1200);
    expect((await ImportJobModel.findById(id).lean())?.totals).toMatchObject({
      rows: 1200,
      created: 1200,
    });

    const id2 = await readyToRun(owner, acc, csvBuffer(borrowerRows(3)));
    vi.spyOn(ContactModel, 'bulkWrite').mockRejectedValue(new Error('still down'));
    expect(
      (
        await runImport({ accountId: acc, importJobId: id2 }, deps, {
          attemptsMade: 2,
          opts: { attempts: 3 },
        })
      ).status,
    ).toBe('failed');
    expect((await ImportJobModel.findById(id2).lean())?.errorMessage).toContain(
      'stopped after 0 rows',
    );
  });

  it('retries a batch once after a duplicate-key race', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const id = await readyToRun(owner, acc, csvBuffer(borrowerRows(5)));
    const real = ContactModel.bulkWrite.bind(ContactModel);
    let calls = 0;
    vi.spyOn(ContactModel, 'bulkWrite').mockImplementation(((ops: never, opts: never) => {
      calls += 1;
      if (calls === 1) return Promise.reject(Object.assign(new Error('dup'), { code: 11000 }));
      return real(ops, opts);
    }) as never);
    expect((await runImport({ accountId: acc, importJobId: id }, deps)).status).toBe('completed');
    expect(calls).toBe(2);
    expect((await ImportJobModel.findById(id).lean())?.totals.created).toBe(5);
  });

  it('cancel mid-run keeps written rows; a suspended account stops the import', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const id = await readyToRun(owner, acc, csvBuffer(borrowerRows(1200)));
    const real = ContactModel.bulkWrite.bind(ContactModel);
    vi.spyOn(ContactModel, 'bulkWrite').mockImplementation((async (ops: never, opts: never) => {
      const result = await real(ops, opts);
      await request(app).post(`${URL}/${id}/cancel`).set(auth(owner));
      return result;
    }) as never);
    expect((await runImport({ accountId: acc, importJobId: id }, deps)).status).toBe('canceled');
    const job = await ImportJobModel.findById(id).lean();
    expect(job).toMatchObject({ status: 'canceled', progress: { processed: 500 } });
    expect(
      await ContactModel.countDocuments({ accountId: t.account._id, 'source.importJobId': id }),
    ).toBe(500);
    expect(
      await AuditLogModel.countDocuments({
        accountId: t.account._id,
        action: 'contacts.import_canceled',
      }),
    ).toBe(1);
    vi.restoreAllMocks();

    const id2 = await readyToRun(owner, acc, csvBuffer(borrowerRows(3)));
    await AccountModel.updateOne({ _id: t.account._id }, { $set: { status: 'suspended' } });
    expect((await runImport({ accountId: acc, importJobId: id2 }, deps)).status).toBe('failed');
    expect((await ImportJobModel.findById(id2).lean())?.errorMessage).toBe(
      'The account was suspended during the import.',
    );
  });

  it('imports 5,000 rows in well under 15 s', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const id = await readyToRun(owner, acc, csvBuffer(borrowerRows(5000)));
    const started = Date.now();
    expect((await runImport({ accountId: acc, importJobId: id }, deps)).status).toBe('completed');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(
      await ContactModel.countDocuments({ accountId: t.account._id, 'source.importJobId': id }),
    ).toBe(5000);
  }, 60_000);

  it('DND uploads add entries and flag contacts', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000300001',
      source: { type: 'manual' },
      variables: { loan_amount: 1 },
    });
    const id = await readyToRun(owner, acc, DND_SAMPLE, { kind: 'dnd' });
    expect((await runImport({ accountId: acc, importJobId: id }, deps)).status).toBe('completed');
    expect((await ImportJobModel.findById(id).lean())?.totals).toMatchObject({
      created: 2,
      unchanged: 2,
      invalid: 1,
    });
    const entry = await DndEntryModel.findOne({
      accountId: t.account._id,
      phoneE164: '+919000300001',
    }).lean();
    expect(entry).toMatchObject({ source: 'upload', reason: 'Complaint' });
    expect(
      (await ContactModel.findOne({ accountId: t.account._id, phoneE164: '+919000300001' }).lean())
        ?.dnd,
    ).toBe(true);
    const audit = await AuditLogModel.findOne({
      accountId: t.account._id,
      action: 'dnd.added',
    }).lean();
    expect(audit?.meta).toEqual({ count: 2, source: 'upload' });
  });

  it('reports external-id conflicts instead of failing the batch', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919999900001',
      externalId: 'LN-9',
      source: { type: 'manual' },
      variables: { loan_amount: 1 },
    });
    const file = csvBuffer([
      ['Mobile', 'Loan ID', 'Loan Amount'],
      ['9000100001', 'LN-9', '1'],
      ['9000100002', 'LN-2', '1'],
      ['9000100003', 'LN-2', '1'],
    ]);
    const id = await readyToRun(owner, acc, file);
    await runImport({ accountId: acc, importJobId: id }, deps);
    const job = await ImportJobModel.findById(id).lean();
    expect(job?.totals).toMatchObject({ created: 1, invalid: 2 });
    expect(job?.problemRows.map((p) => p.reasons[0])).toEqual([
      'external_id_taken',
      'duplicate_external_id:3',
    ]);
  });
});

describe('start rules', () => {
  it('needs a validated job; refuses clashes, taken names, deleted lists and other accounts', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const up = await request(app)
      .post(URL)
      .set(auth(owner))
      .attach('file', csvBuffer(borrowerRows(2)), {
        filename: 'a.csv',
        contentType: 'text/csv',
      });
    const id = up.body.data.id as string;
    expect((await request(app).post(`${URL}/${id}/start`).set(auth(owner))).status).toBe(409);
    await request(app)
      .put(`${URL}/${id}/mapping`)
      .set(auth(owner))
      .send({
        columns: up.body.data.suggestedMapping,
        options: { list: { mode: 'new', name: 'Later' }, tags: [] },
      });
    await request(app).post(`${URL}/${id}/validate`).set(auth(owner));
    await validateImport({ accountId: acc, importJobId: id }, deps);

    // a field with the new key appears meanwhile
    await CustomFieldModel.create({
      accountId: t.account._id,
      key: 'due_date',
      label: 'Due',
      type: 'date',
      order: 9,
    });
    const clash = await request(app).post(`${URL}/${id}/start`).set(auth(owner));
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toContain('due_date');
    await CustomFieldModel.deleteOne({ accountId: t.account._id, key: 'due_date' });

    // the list name gets taken meanwhile
    await ContactListModel.create({
      accountId: t.account._id,
      name: 'later',
      source: { type: 'manual' },
    });
    expect((await request(app).post(`${URL}/${id}/start`).set(auth(owner))).status).toBe(409);
    expect(await CustomFieldModel.exists({ accountId: t.account._id, key: 'due_date' })).toBeNull(); // rolled back

    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    expect((await request(app).post(`${URL}/${id}/start`).set(auth(otherOwner))).status).toBe(404);
    expect(await runImport({ accountId: acc, importJobId: id }, deps)).toEqual({
      status: 'validated',
    });
  });

  it('refuses an existing list that was deleted after mapping', async () => {
    const { t, owner } = await setupAccount();
    const acc = t.account._id.toString();
    const list = await ContactListModel.create({
      accountId: t.account._id,
      name: 'Soon gone',
      source: { type: 'manual' },
    });
    const up = await request(app)
      .post(URL)
      .set(auth(owner))
      .attach('file', csvBuffer(borrowerRows(2)), {
        filename: 'a.csv',
        contentType: 'text/csv',
      });
    const id = up.body.data.id as string;
    await request(app)
      .put(`${URL}/${id}/mapping`)
      .set(auth(owner))
      .send({
        columns: up.body.data.suggestedMapping,
        options: { list: { mode: 'existing', listId: list._id.toString() }, tags: [] },
      });
    await request(app).post(`${URL}/${id}/validate`).set(auth(owner));
    await validateImport({ accountId: acc, importJobId: id }, deps);
    await ContactListModel.updateOne({ _id: list._id }, { $set: { deletedAt: new Date() } });
    const res = await request(app).post(`${URL}/${id}/start`).set(auth(owner));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('deleted');
  });
});
