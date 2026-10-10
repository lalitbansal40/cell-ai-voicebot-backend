import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  CONTACTS_PURGE_JOB,
  EXPORT_FILES_PURGE_JOB,
  IMPORT_FILES_PURGE_JOB,
  MAINTENANCE_SCHEDULES,
  processMaintenanceJob,
} from '../../src/core/queues/workers/maintenance.worker';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { ImportJobModel } from '../../src/db/models/import-job.model';
import {
  purgeDeletedContacts,
  purgeExportFiles,
  purgeImportFiles,
} from '../../src/modules/contacts/retention';
import { createLogger } from '../../src/shared/logger';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';

useTestDb();
const storage = useTempStorage();
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const NOW = new Date('2026-10-09T03:15:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const accountId = new Types.ObjectId();
const by = new Types.ObjectId();

describe('purgeDeletedContacts', () => {
  it('hard-deletes only contacts / lists soft-deleted more than 30 days ago', async () => {
    const mk = (phone: string, deletedAt: Date | null) =>
      ContactModel.create({ accountId, phoneE164: phone, source: { type: 'manual' }, deletedAt });
    await mk('+919000800001', daysAgo(31));
    await mk('+919000800002', daysAgo(29));
    await mk('+919000800003', null);
    await ContactListModel.create({
      accountId,
      name: 'Old',
      source: { type: 'manual' },
      deletedAt: daysAgo(40),
    });
    await ContactListModel.create({
      accountId,
      name: 'Recent',
      source: { type: 'manual' },
      deletedAt: daysAgo(1),
    });
    expect(await purgeDeletedContacts(NOW)).toEqual({ contacts: 1, lists: 1 });
    expect(await purgeDeletedContacts(NOW)).toEqual({ contacts: 0, lists: 0 });
    const left = await ContactModel.find({ accountId }).setOptions({ withDeleted: true }).lean();
    expect(left.map((c) => c.phoneE164).sort()).toEqual(['+919000800002', '+919000800003']);
  });
});

describe('purgeImportFiles', () => {
  it('deletes files + samples 30 days after the job ended, keeps the totals', async () => {
    const put = async (key: string) => {
      await storage.put(key, Buffer.from('x'), { contentType: 'text/csv' });
      return key;
    };
    const base = {
      accountId,
      kind: 'contacts' as const,
      fileName: 'a.csv',
      fileType: 'csv' as const,
      fileSize: 1,
      createdBy: by,
      columns: [{ index: 0, header: 'Phone', samples: ['9876543210'] }],
      totals: { rows: 5, created: 5, updated: 0, unchanged: 0, invalid: 0, duplicates: 0, dnd: 0 },
    };
    const old = await ImportJobModel.create({
      ...base,
      status: 'completed',
      completedAt: daysAgo(31),
      fileKey: await put('accounts/x/imports/old.csv'),
      errorReportKey: await put('accounts/x/import-reports/old.csv'),
    });
    const failed = await ImportJobModel.create({
      ...base,
      status: 'failed',
      failedAt: daysAgo(45),
      fileKey: 'accounts/x/imports/missing.csv',
    });
    const fresh = await ImportJobModel.create({
      ...base,
      status: 'completed',
      completedAt: daysAgo(2),
      fileKey: await put('accounts/x/imports/fresh.csv'),
    });
    const running = await ImportJobModel.create({
      ...base,
      status: 'importing',
      fileKey: await put('accounts/x/imports/run.csv'),
    });

    expect(await purgeImportFiles(storage, NOW)).toEqual({ jobs: 2 });
    expect(await purgeImportFiles(storage, NOW)).toEqual({ jobs: 0 });
    const purged = await ImportJobModel.findById(old._id).lean();
    expect(purged).toMatchObject({
      fileKey: null,
      errorReportKey: null,
      totals: { rows: 5, created: 5 },
    });
    expect(purged?.filesPurgedAt).toEqual(NOW);
    expect(purged?.columns[0]?.samples).toEqual([]);
    expect(await storage.exists('accounts/x/imports/old.csv')).toBe(false);
    expect(await storage.exists('accounts/x/import-reports/old.csv')).toBe(false);
    expect((await ImportJobModel.findById(failed._id).lean())?.filesPurgedAt).toEqual(NOW);
    expect(await storage.exists('accounts/x/imports/fresh.csv')).toBe(true);
    expect((await ImportJobModel.findById(fresh._id).lean())?.fileKey).toBeTruthy();
    expect((await ImportJobModel.findById(running._id).lean())?.fileKey).toBeTruthy();
  });
});

describe('purgeExportFiles', () => {
  it('expires ready exports after 24 h and deletes the file', async () => {
    await storage.put('accounts/x/exports/e1.csv', Buffer.from('x'), { contentType: 'text/csv' });
    const expired = await ExportJobModel.create({
      accountId,
      scope: 'filter',
      createdBy: by,
      status: 'ready',
      fileKey: 'accounts/x/exports/e1.csv',
      expiresAt: daysAgo(0.01),
    });
    const valid = await ExportJobModel.create({
      accountId,
      scope: 'filter',
      createdBy: by,
      status: 'ready',
      fileKey: 'accounts/x/exports/e2.csv',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect(await purgeExportFiles(storage, NOW)).toEqual({ jobs: 1 });
    expect(await ExportJobModel.findById(expired._id).lean()).toMatchObject({
      status: 'expired',
      fileKey: null,
    });
    expect(await storage.exists('accounts/x/exports/e1.csv')).toBe(false);
    expect((await ExportJobModel.findById(valid._id).lean())?.status).toBe('ready');
  });
});

describe('maintenance worker', () => {
  it('schedules and dispatches the purge jobs; storage is required for file purges', async () => {
    expect(MAINTENANCE_SCHEDULES.map((s) => [s.name, s.pattern])).toEqual([
      ['audit-purge', '0 3 * * *'],
      ['contacts-purge', '15 3 * * *'],
      ['import-files-purge', '30 3 * * *'],
      ['export-files-purge', '0 * * * *'],
    ]);
    const run = processMaintenanceJob({ logger, storage });
    // the worker uses the real clock: rows made by the tests above (dated from
    // a fixed NOW) may or may not be past 30 days today — only the shape matters here
    await expect(run({ name: CONTACTS_PURGE_JOB } as never)).resolves.toEqual({
      contacts: expect.any(Number) as number,
      lists: expect.any(Number) as number,
    });
    await expect(run({ name: IMPORT_FILES_PURGE_JOB } as never)).resolves.toEqual({
      jobs: expect.any(Number) as number,
    });
    await expect(run({ name: EXPORT_FILES_PURGE_JOB } as never)).resolves.toEqual({
      jobs: expect.any(Number) as number,
    });
    await expect(
      processMaintenanceJob({ logger })({ name: EXPORT_FILES_PURGE_JOB } as never),
    ).rejects.toThrow('needs file storage');
  });
});
