import { readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SAMPLE_DND_PHONES, SAMPLE_EXISTING_PHONES } from '../../scripts/make-contact-samples';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { ImportJobModel } from '../../src/db/models/import-job.model';
import { readStoredFile } from '../../src/modules/contact-imports/storage-io';
import { validateImport } from '../../src/modules/contact-imports/validate.job';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const rec = recordingContactJobs();
const app = buildTestApp({}, { storage, contactJobs: rec.jobs });
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/contact-imports';
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const deps = { storage, logger };
const SAMPLES = path.resolve(__dirname, '../../docs/samples');

let t: TestAccount;
let owner: TestUser;

afterEach(() => vi.restoreAllMocks());

const prepared = async (file = 'contacts-sample-100.csv', kind = 'contacts') => {
  const up = await request(app)
    .post(URL)
    .set(auth(owner))
    .field('kind', kind)
    .attach('file', readFileSync(path.join(SAMPLES, file)), {
      filename: file,
      contentType: 'text/csv',
    });
  expect(up.status).toBe(201);
  const id = up.body.data.id as string;
  const mapped = await request(app)
    .put(`${URL}/${id}/mapping`)
    .set(auth(owner))
    .send({ columns: up.body.data.suggestedMapping });
  expect(mapped.status).toBe(200);
  return id;
};

const validate = async (id: string) => {
  rec.queued.length = 0;
  const res = await request(app).post(`${URL}/${id}/validate`).set(auth(owner));
  expect(res.status).toBe(202);
  expect(res.body.data.status).toBe('validating');
  expect(rec.queued).toEqual([
    { name: 'import.validate', data: { accountId: t.account._id.toString(), importJobId: id } },
  ]);
  return validateImport({ accountId: t.account._id.toString(), importJobId: id }, deps);
};

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
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
      source: { type: 'manual' },
      variables: { loan_amount: 1_000_000 },
    });
  }
  for (const phone of SAMPLE_DND_PHONES) {
    await DndEntryModel.create({ accountId: t.account._id, phoneE164: phone, source: 'manual' });
  }
});

describe('validate (dry run)', () => {
  it('reports the exact mix of the 100-row sample without writing contacts', async () => {
    const before = await ContactModel.countDocuments({ accountId: t.account._id });
    const id = await prepared();
    expect(await validate(id)).toEqual({ status: 'validated' });

    const job = await request(app).get(`${URL}/${id}`).set(auth(owner));
    expect(job.body.data).toMatchObject({
      status: 'validated',
      progress: { processed: 100, total: 100 },
      hasErrorReport: true,
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
    const problems = job.body.data.problemRows as { row: number; reasons: string[] }[];
    expect(problems).toHaveLength(11);
    expect(problems.slice(0, 5).map((p) => p.reasons[0])).toEqual([
      'phone_invalid',
      'phone_lost_digits',
      'phone_invalid',
      'phone_missing',
      'phone_invalid',
    ]);
    expect(problems.slice(5, 8).map((p) => p.reasons)).toEqual([
      ['missing_required:loan_amount'],
      ['missing_required:loan_amount'],
      ['missing_required:loan_amount'],
    ]);
    expect(problems.slice(8).map((p) => [p.row, p.reasons])).toEqual([
      [99, ['duplicate_of_row:2']],
      [100, ['duplicate_of_row:3']],
      [101, ['duplicate_of_row:4']],
    ]);
    expect(await ContactModel.countDocuments({ accountId: t.account._id })).toBe(before);

    const stored = await ImportJobModel.findById(id).lean();
    const csv = (await readStoredFile(storage, stored?.errorReportKey ?? '')).toString('utf8');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      '﻿row,Name,Mobile No,Email,Loan ID,Loan Amount,Due Date,DPD,Branch,Tags,reasons',
    );
    expect(lines[2]).toContain('9.00011E+09');
    expect(lines[2]).toContain('Phone lost digits in Excel (format the column as Text)');
    expect(lines.filter(Boolean)).toHaveLength(12);
    expect(csv).toContain('Same phone as row 2');
    expect(csv).toContain('loan_amount: required');
  });

  it('can be re-run after a mapping change; a running check blocks another (409)', async () => {
    const id = await prepared();
    await request(app).post(`${URL}/${id}/validate`).set(auth(owner));
    const second = await prepared();
    const blocked = await request(app).post(`${URL}/${second}/validate`).set(auth(owner));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Another import');
    await validateImport({ accountId: t.account._id.toString(), importJobId: id }, deps);
    expect((await validate(second)).status).toBe('validated');
    // validated → can validate again; uploaded → must map first
    expect((await validate(second)).status).toBe('validated');
    const raw = await request(app)
      .post(URL)
      .set(auth(owner))
      .attach('file', readFileSync(path.join(SAMPLES, 'contacts-sample-100.csv')), {
        filename: 'x.csv',
        contentType: 'text/csv',
      });
    const notMapped = await request(app)
      .post(`${URL}/${raw.body.data.id as string}/validate`)
      .set(auth(owner));
    expect(notMapped.status).toBe(409);
    expect(notMapped.body.error.message).toBe('Map the columns first.');
  });

  it('marks the job failed (no PII in the message) and frees the lock', async () => {
    const id = await prepared();
    const job = await ImportJobModel.findById(id).lean();
    await storage.delete(job?.fileKey ?? '');
    expect((await validate(id)).status).toBe('failed');
    const failed = await ImportJobModel.findById(id).lean();
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.errorMessage).toContain('try again');
    expect(failed?.failedAt).toBeTruthy();
    // lock released → another job can validate
    const next = await prepared();
    expect((await validate(next)).status).toBe('validated');
  });

  it('skips jobs that are not validating and handles a cancel during the run', async () => {
    const id = await prepared();
    expect(
      await validateImport({ accountId: t.account._id.toString(), importJobId: id }, deps),
    ).toEqual({
      status: 'mapped',
    });
    expect(
      await validateImport(
        { accountId: t.account._id.toString(), importJobId: '0'.repeat(24) },
        deps,
      ),
    ).toEqual({ status: 'missing' });
    await request(app).post(`${URL}/${id}/validate`).set(auth(owner));
    vi.spyOn(ImportJobModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => Promise.resolve(null),
    } as never);
    expect(
      (await validateImport({ accountId: t.account._id.toString(), importJobId: id }, deps)).status,
    ).toBe('canceled');
  });

  it('validates DND files (already listed → unchanged)', async () => {
    const id = await prepared('dnd-sample.csv', 'dnd');
    expect((await validate(id)).status).toBe('validated');
    const job = await ImportJobModel.findById(id).lean();
    expect(job?.totals).toMatchObject({
      rows: 5,
      created: 2,
      unchanged: 2,
      invalid: 1,
      duplicates: 0,
    });
  });

  it('a lock cannot be taken and the job is restored when enqueueing fails', async () => {
    const id = await prepared();
    const failing = buildTestApp(
      {},
      { storage, contactJobs: { enqueue: () => Promise.reject(new Error('redis down')) } },
    );
    expect((await request(failing).post(`${URL}/${id}/validate`).set(auth(owner))).status).toBe(
      500,
    );
    expect((await ImportJobModel.findById(id).lean())?.status).toBe('mapped');
    expect((await validate(id)).status).toBe('validated');
  });
});
