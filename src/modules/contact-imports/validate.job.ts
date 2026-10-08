import { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import { storageKey, type StorageProvider } from '../../core/storage';
import { ImportJobModel, type ImportJobDoc } from '../../db/models/import-job.model';
import type { Logger } from '../../shared/logger';
import type { ContactJobData } from '../contacts/jobs';
import { releaseJobLock } from '../contacts/locks';
import { createProgressReporter } from '../contacts/progress';

import { addToTotals, analyseBatch, batches, emptyImportTotals, loadPlan } from './analyse';
import { buildErrorReport } from './error-report';
import { deleteQuietly } from './storage-io';

export interface ImportJobDeps {
  storage: StorageProvider;
  logger: Pick<Logger, 'warn' | 'info'>;
}

const errorMessageOf = (err: unknown): string =>
  err instanceof Error && (err as { code?: string }).code === 'IMPORT_FILE_INVALID'
    ? err.message
    : 'Something went wrong while checking the file — please try again.';

/**
 * `import.validate` — dry run: no contact is written. Produces totals,
 * the first problem rows and an error CSV (PHASE_3_PLAN T3.8).
 */
export const validateImport = async (
  { accountId, importJobId }: ContactJobData['import.validate'],
  { storage, logger }: ImportJobDeps,
): Promise<{ status: string }> => {
  const _id = new Types.ObjectId(importJobId);
  const account = new Types.ObjectId(accountId);
  const job = await ImportJobModel.findOne({ _id, accountId: account }).lean<ImportJobDoc>();
  if (job?.status !== 'validating') return { status: job?.status ?? 'missing' };
  const report = createProgressReporter(accountId, 'import.progress', { importJobId });
  try {
    const plan = await loadPlan(job, storage);
    const seen = new Map<string, number>();
    const problems: { rowNumber: number; cells: string[]; reasons: string[] }[] = [];
    let totals = emptyImportTotals();
    let processed = 0;
    report(0, plan.sheet.rows.length, 'validating', true);
    for (const batch of batches(plan.sheet.rows)) {
      const analysed = await analyseBatch(job, plan, batch, seen);
      totals = addToTotals(totals, analysed);
      for (const r of analysed) {
        if (r.reasons.length)
          problems.push({ rowNumber: r.candidate.rowNumber, cells: r.cells, reasons: r.reasons });
      }
      processed += batch.length;
      await ImportJobModel.updateOne({ _id }, { $set: { 'progress.processed': processed } });
      report(processed, plan.sheet.rows.length, 'validating');
    }

    let errorReportKey: string | null = null;
    if (problems.length) {
      errorReportKey = storageKey({
        accountId,
        area: 'import-reports',
        id: importJobId,
        ext: 'csv',
      });
      await storage.put(errorReportKey, buildErrorReport(plan.sheet.header, problems), {
        contentType: 'text/csv',
      });
    }
    const updated = await ImportJobModel.findOneAndUpdate(
      { _id, status: 'validating' },
      {
        $set: {
          status: 'validated',
          totals,
          problemRows: problems
            .slice(0, CONTACT_LIMITS.problemRowsInline)
            .map((p) => ({ row: p.rowNumber, reasons: p.reasons })),
          errorReportKey,
          progress: { processed, total: plan.sheet.rows.length },
        },
      },
      { new: true },
    ).lean();
    if (!updated) await deleteQuietly(storage, errorReportKey); // canceled meanwhile
    report(processed, plan.sheet.rows.length, updated ? 'validated' : 'canceled', true);
    logger.info(
      { importJobId, rows: totals.rows, invalid: totals.invalid },
      'contacts: import validated',
    );
    return { status: updated ? 'validated' : 'canceled' };
  } catch (err) {
    logger.warn(
      { importJobId, err: err instanceof Error ? err.name : 'error' },
      'contacts: import validation failed',
    );
    await ImportJobModel.updateOne(
      { _id, status: 'validating' },
      { $set: { status: 'failed', failedAt: new Date(), errorMessage: errorMessageOf(err) } },
    );
    report(job.progress.processed, job.rowCount, 'failed', true);
    return { status: 'failed' };
  } finally {
    await releaseJobLock('import', accountId, importJobId);
  }
};
