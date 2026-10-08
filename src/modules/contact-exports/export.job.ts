import { stringify } from 'csv-stringify/sync';
import { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import { storageKey } from '../../core/storage';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ExportJobModel, type ExportJobDoc } from '../../db/models/export-job.model';
import { recordAudit } from '../audit/audit.service';
import { safeCell } from '../contact-imports/error-report';
import type { ImportJobDeps } from '../contact-imports/validate.job';
import { loadContactContext, type ContactContext } from '../contacts/context';
import type { ContactJobData } from '../contacts/jobs';
import { releaseJobLock } from '../contacts/locks';
import { formatFieldValue } from '../contacts/normalize';
import { createProgressReporter } from '../contacts/progress';

import { selectionQuery } from './contact-exports.service';

const yesNo = (v: boolean) => (v ? 'yes' : 'no');

/** One contact → CSV cells for the chosen columns (phones stay as E.164, others injection-safe). */
export const exportRow = (
  c: ContactDoc,
  columns: string[],
  ctx: ContactContext,
  listNames: Map<string, string>,
): string[] => {
  const variables = (c.variables as unknown as Record<string, string | number> | undefined) ?? {};
  return columns.map((col) => {
    switch (col) {
      case 'phone':
        return c.phoneE164;
      case 'name':
        return safeCell(c.name ?? '');
      case 'email':
        return safeCell(c.email ?? '');
      case 'external_id':
        return safeCell(c.externalId ?? '');
      case 'tags':
        return safeCell(c.tags.join(', '));
      case 'lists':
        return safeCell(
          c.listIds
            .map((id) => listNames.get(id.toString()) ?? '')
            .filter(Boolean)
            .join(', '),
        );
      case 'dnd':
        return yesNo(c.dnd);
      case 'opted_out':
        return yesNo(Boolean(c.optedOutAt));
      case 'consent_source':
        return safeCell(c.consent?.source ?? '');
      case 'consent_at':
        return c.consent ? c.consent.at.toISOString() : '';
      case 'created_at':
        return c.createdAt.toISOString();
      default: {
        const field = ctx.byKey.get(col);
        if (!field) return '';
        const value = formatFieldValue(field.type, variables[col]);
        return field.type === 'phone' ? value : safeCell(value);
      }
    }
  });
};

/** `export.run` — CSV (UTF-8 BOM, CRLF) into storage; link valid 24 h. */
export const runExport = async (
  { accountId, exportJobId }: ContactJobData['export.run'],
  { storage, logger }: ImportJobDeps,
): Promise<{ status: string; rows?: number }> => {
  const _id = new Types.ObjectId(exportJobId);
  const account = new Types.ObjectId(accountId);
  const job = await ExportJobModel.findOneAndUpdate(
    { _id, accountId: account, status: 'pending' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  ).lean<ExportJobDoc>();
  if (!job) {
    await releaseJobLock('export', accountId, exportJobId);
    return { status: 'skipped' };
  }
  const report = createProgressReporter(accountId, 'export.progress', { exportJobId });
  try {
    const ctx = await loadContactContext(account);
    const query = selectionQuery(ctx, job.filter, false);
    const total = await ContactModel.countDocuments(query);
    if (total > CONTACT_LIMITS.exportMaxRows) throw new Error('too_many_rows');
    const lists = await ContactListModel.find({ accountId: account })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>();
    const listNames = new Map(lists.map((l) => [l._id.toString(), l.name]));

    const records: string[][] = [job.columns];
    let processed = 0;
    let lastId: Types.ObjectId | null = null;
    report(0, total, 'processing', true);
    for (;;) {
      const page: ContactDoc[] = await ContactModel.find(
        lastId ? { $and: [query, { _id: { $gt: lastId } }] } : query,
      )
        .sort({ _id: 1 })
        .limit(CONTACT_LIMITS.exportBatchSize)
        .lean<ContactDoc[]>();
      if (!page.length) break;
      for (const c of page) records.push(exportRow(c, job.columns, ctx, listNames));
      processed += page.length;
      lastId = page[page.length - 1]?._id ?? null;
      await ExportJobModel.updateOne(
        { _id },
        { $set: { 'progress.processed': processed, 'progress.total': total } },
      );
      report(processed, total, 'processing');
    }

    const fileKey = storageKey({ accountId, area: 'exports', id: exportJobId, ext: 'csv' });
    const csv = Buffer.concat([
      Buffer.from('\uFEFF'),
      Buffer.from(stringify(records, { record_delimiter: '\r\n' })),
    ]);
    await storage.put(fileKey, csv, { contentType: 'text/csv' });
    const now = new Date();
    await ExportJobModel.updateOne(
      { _id },
      {
        $set: {
          status: 'ready',
          fileKey,
          rowCount: processed,
          completedAt: now,
          expiresAt: new Date(now.getTime() + CONTACT_LIMITS.exportRetentionHours * 3_600_000),
          progress: { processed, total },
        },
      },
    );
    await recordAudit({
      accountId: account,
      actor: { type: 'user', id: job.createdBy },
      action: 'contacts.exported',
      target: { type: 'export_job', id: exportJobId },
      meta: { scope: job.scope, rows: processed },
    });
    report(processed, total, 'ready', true);
    return { status: 'ready', rows: processed };
  } catch (err) {
    logger.warn(
      { exportJobId, err: err instanceof Error ? err.name : 'error' },
      'contacts: export failed',
    );
    const message =
      err instanceof Error && err.message === 'too_many_rows'
        ? `More than ${CONTACT_LIMITS.exportMaxRows} contacts match — narrow the selection.`
        : 'The export failed — please try again.';
    await ExportJobModel.updateOne({ _id }, { $set: { status: 'failed', errorMessage: message } });
    report(job.progress.processed, job.progress.total, 'failed', true);
    return { status: 'failed' };
  } finally {
    await releaseJobLock('export', accountId, exportJobId);
  }
};
