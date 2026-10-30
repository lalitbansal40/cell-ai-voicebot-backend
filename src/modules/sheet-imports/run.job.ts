import { Types } from 'mongoose';

import type { Env } from '../../config/env';
import { storageKey, type StorageProvider } from '../../core/storage';
import {
  ImportJobModel,
  emptyImportTotals,
  type ImportJobDoc,
} from '../../db/models/import-job.model';
import { SheetImportModel, type SheetImportDoc } from '../../db/models/sheet-import.model';
import { AppError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { columnsOf } from '../contact-imports/contact-imports.service';
import { runImport } from '../contact-imports/run.job';
import type { ContactJobData, ContactJobs } from '../contacts/jobs';
import { acquireJobLock } from '../contacts/locks';

import { fetchSheet } from './fetch';
import { enqueueSheetRun } from './sheet-imports.service';

const HOUR_MS = 3_600_000;

export interface SheetRunDeps {
  env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>;
  storage?: StorageProvider | undefined;
  logger: Logger;
  now?: () => Date;
}

const nextRun = (s: Pick<SheetImportDoc, 'schedule'>, at: Date): Date | null =>
  s.schedule === 'hourly'
    ? new Date(at.getTime() + HOUR_MS)
    : s.schedule === 'daily'
      ? new Date(at.getTime() + 24 * HOUR_MS)
      : null;

/**
 * `sheets.import` (contacts queue, job id `sheet-<id>-<runKey>`): downloads the
 * published CSV again and imports it through the file-import pipeline (an
 * `importJobs` row with the saved mapping, the sheet's list, "update existing by
 * phone", validation, dedupe, DND, the error file) — then the next run time. Busy
 * (another import of the account running) → tried again at the next schedule.
 */
export const runSheetImport = async (
  deps: SheetRunDeps,
  data: ContactJobData['sheets.import'],
): Promise<{ status: string }> => {
  const now = deps.now?.() ?? new Date();
  const sheet = await SheetImportModel.findOne({
    _id: new Types.ObjectId(data.sheetImportId),
    accountId: new Types.ObjectId(data.accountId),
  })
    .select('+url')
    .lean<SheetImportDoc>();
  if (!sheet) return { status: 'missing' };
  const finish = async (
    status: SheetImportDoc['lastStatus'],
    extra: Partial<SheetImportDoc> = {},
  ) => {
    await SheetImportModel.updateOne(
      { _id: sheet._id },
      { $set: { lastStatus: status, lastRunAt: now, nextRunAt: nextRun(sheet, now), ...extra } },
    );
    deps.logger.info({ sheetImportId: data.sheetImportId, status }, 'sheet import: run done');
    return { status: status ?? 'done' };
  };
  if (!deps.storage) return finish('failed', { lastError: 'File storage is not configured' });
  const importJobId = new Types.ObjectId();
  if (!(await acquireJobLock('import', data.accountId, importJobId.toString())))
    return finish('busy', { lastError: 'Another import of this account was running' });

  let fetched: Awaited<ReturnType<typeof fetchSheet>>;
  try {
    fetched = await fetchSheet(deps.env, sheet.url);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return finish('failed', { lastError: err.details?.[0]?.message ?? err.message });
  }
  const fileKey = storageKey({
    accountId: data.accountId,
    area: 'imports',
    id: importJobId.toString(),
    ext: 'csv',
  });
  await deps.storage.put(fileKey, fetched.buffer, { contentType: 'text/csv' });
  await ImportJobModel.create({
    _id: importJobId,
    accountId: sheet.accountId,
    kind: 'contacts',
    fileName: `${sheet.name.slice(0, 200)}.csv`,
    fileKey,
    fileType: 'csv',
    fileSize: fetched.buffer.length,
    sheet: fetched.sheet.sheet,
    sheets: fetched.sheet.sheets,
    columns: columnsOf(fetched.sheet),
    rowCount: fetched.sheet.rows.length,
    warnings: fetched.sheet.warnings,
    status: 'importing',
    // the importer adds every row to this list (what startImport sets for file imports)
    listId: sheet.listId,
    mapping: sheet.mapping,
    options: {
      list: { mode: 'existing', listId: sheet.listId.toString() },
      updateExisting: sheet.updateExisting,
      tags: sheet.tags,
      consentSource: null,
    },
    progress: { processed: 0, total: fetched.sheet.rows.length },
    totals: emptyImportTotals(),
    createdBy: sheet.createdBy ?? new Types.ObjectId('000000000000000000000000'),
  });
  const result = await runImport(
    { accountId: data.accountId, importJobId: importJobId.toString() },
    { storage: deps.storage, logger: deps.logger },
  );
  const job = await ImportJobModel.findById(importJobId)
    .select({ totals: 1, status: 1 })
    .lean<Pick<ImportJobDoc, 'totals' | 'status'>>();
  const t = job?.totals ?? emptyImportTotals();
  return finish(result.status === 'completed' ? 'ok' : 'failed', {
    lastError: result.status === 'completed' ? null : `Import ${result.status}`,
    lastResult: {
      importJobId,
      rows: t.rows,
      created: t.created,
      updated: t.updated,
      failed: t.invalid + t.duplicates + t.dnd,
    },
  });
};

/** Maintenance `sheet-imports` (every 15 min): queues the imports that are due. */
export const queueDueSheetImports = async (
  jobs: ContactJobs,
  now: Date = new Date(),
): Promise<{ queued: number }> => {
  // a run that died (process restart) is picked up again after an hour
  const stale = new Date(now.getTime() - HOUR_MS);
  const notRunning = {
    $or: [{ lastStatus: { $ne: 'running' as const } }, { updatedAt: { $lt: stale } }],
  };
  const due = await SheetImportModel.find({
    active: true,
    nextRunAt: { $ne: null, $lte: now },
    ...notRunning,
  })
    .select({ _id: 1, accountId: 1 })
    .limit(500)
    .lean<Pick<SheetImportDoc, '_id' | 'accountId'>[]>();
  let queued = 0;
  for (const s of due) {
    const claimed = await SheetImportModel.updateOne(
      { _id: s._id, ...notRunning },
      { $set: { lastStatus: 'running' } },
    );
    if (!claimed.modifiedCount) continue;
    await enqueueSheetRun(jobs, s, String(now.getTime()));
    queued += 1;
  }
  return { queued };
};
