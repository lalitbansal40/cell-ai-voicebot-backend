import path from 'node:path';

import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { CONTACT_LIMITS } from '../../config/limits';
import { storageKey, type StorageProvider } from '../../core/storage';
import { ContactListModel } from '../../db/models/contact-list.model';
import { CustomFieldModel } from '../../db/models/custom-field.model';
import {
  emptyImportTotals,
  ImportJobModel,
  type ImportJobDoc,
  type ImportKind,
} from '../../db/models/import-job.model';
import { withTransaction } from '../../db/transaction';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { NAME_COLLATION } from '../contact-lists/contact-lists.service';
import { loadContactContext, type ContactContext } from '../contacts/context';
import { isoDay } from '../contacts/filter/compile';
import type { ContactJobs } from '../contacts/jobs';
import { acquireJobLock, releaseJobLock } from '../contacts/locks';
import { normalizeTags } from '../contacts/normalize/tags';
import { formatFieldValue } from '../contacts/normalize/values';

import type { ListImportsQuery, SetMappingBody } from './contact-imports.schema';
import { suggestMapping, validateMapping, type ColumnMapping, type ImportOptions } from './mapping';
import { detectFileType, parseSheet, type ParsedSheet } from './parsers';
import { deleteQuietly, readStoredFile } from './storage-io';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const SAMPLE_SCAN_ROWS = 200;
const SAMPLE_MAX_LENGTH = 100;
const MAPPABLE = ['uploaded', 'mapped', 'validated'] as const;

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

/** First non-empty values per column (shown on the mapping screen). */
export const columnsOf = (sheet: ParsedSheet) =>
  sheet.header.map((header, index) => {
    const samples: string[] = [];
    for (const row of sheet.rows.slice(0, SAMPLE_SCAN_ROWS)) {
      const value = (row.cells[index] ?? '').trim();
      if (value) samples.push(value.slice(0, SAMPLE_MAX_LENGTH));
      if (samples.length >= CONTACT_LIMITS.importSampleValues) break;
    }
    return { index, header, samples };
  });

export const toPublicImport = (job: ImportJobDoc, ctx?: ContactContext) => ({
  id: job._id.toString(),
  kind: job.kind,
  fileName: job.fileName,
  fileType: job.fileType,
  fileSize: job.fileSize,
  sheet: job.sheet ?? null,
  sheets: [...job.sheets],
  columns: job.columns.map((c) => ({ index: c.index, header: c.header, samples: [...c.samples] })),
  rowCount: job.rowCount,
  mapping: (job.mapping as { columns: ColumnMapping[] } | null | undefined) ?? null,
  options: (job.options as ImportOptions | null | undefined) ?? null,
  ...(ctx && (MAPPABLE as readonly string[]).includes(job.status)
    ? { suggestedMapping: suggestMapping(job.kind, job.columns, ctx.fields, ctx.country) }
    : {}),
  status: job.status,
  progress: { processed: job.progress.processed, total: job.progress.total },
  totals: { ...emptyImportTotals(), ...job.totals },
  problemRows: job.problemRows.map((p) => ({ row: p.row, reasons: [...p.reasons] })),
  hasErrorReport: Boolean(job.errorReportKey),
  listId: job.listId ? job.listId.toString() : null,
  warnings: [...job.warnings],
  errorMessage: job.errorMessage ?? null,
  createdBy: job.createdBy.toString(),
  startedAt: iso(job.startedAt),
  completedAt: iso(job.completedAt),
  failedAt: iso(job.failedAt),
  canceledAt: iso(job.canceledAt),
  createdAt: job.createdAt.toISOString(),
  updatedAt: job.updatedAt.toISOString(),
});
export type PublicImportJob = ReturnType<typeof toPublicImport>;

export const findImport = async (req: Request, id: string): Promise<ImportJobDoc> => {
  const _id = toObjectId(id);
  const job = _id
    ? await ImportJobModel.findOne({ _id, ...tenantFilter(req) }).lean<ImportJobDoc>()
    : null;
  if (!job) throw new NotFoundError('Import not found');
  return job;
};

const safeFileName = (name: string): string =>
  path
    .basename(name)
    .replace(/\p{Cc}/gu, '')
    .slice(0, 255) || 'upload';

export const uploadImport = async (
  req: Request,
  file: UploadedFile | undefined,
  kind: ImportKind,
  storage: StorageProvider,
): Promise<PublicImportJob> => {
  const auth = requireAuth(req);
  if (kind === 'dnd' && !auth.permissions.has('contacts.write')) throw new ForbiddenError();
  if (!file) throw new ValidationError([{ path: 'file', message: 'Choose a .csv or .xlsx file' }]);
  const fileType = detectFileType(file.originalname, file.mimetype, file.buffer);
  if (!fileType) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Upload a .csv or .xlsx file. Old .xls files: open in Excel and save as .xlsx.',
    );
  }
  const sheet = await parseSheet(file.buffer, fileType);
  const { accountId } = tenantFilter(req);
  const _id = new Types.ObjectId();
  const fileKey = storageKey({
    accountId: accountId.toString(),
    area: 'imports',
    id: _id.toString(),
    ext: fileType,
  });
  await storage.put(fileKey, file.buffer, {
    contentType:
      fileType === 'csv'
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const job = await ImportJobModel.create({
    _id,
    accountId,
    kind,
    fileName: safeFileName(file.originalname),
    fileKey,
    fileType,
    fileSize: file.size,
    sheet: sheet.sheet,
    sheets: sheet.sheets,
    columns: columnsOf(sheet),
    rowCount: sheet.rows.length,
    warnings: sheet.warnings,
    status: 'uploaded',
    progress: { processed: 0, total: sheet.rows.length },
    createdBy: new Types.ObjectId(auth.userId),
  });
  const ctx = await loadContactContext(accountId);
  return toPublicImport(job.toObject({ transform: false }), ctx);
};

export const getImport = async (req: Request, id: string): Promise<PublicImportJob> => {
  const job = await findImport(req, id);
  return toPublicImport(job, await loadContactContext(job.accountId));
};

export const listImports = async (req: Request, q: z.infer<typeof ListImportsQuery>) => {
  const filter: Record<string, unknown> = { ...tenantFilter(req) };
  if (q.kind) filter.kind = q.kind;
  if (q.status) filter.status = q.status;
  const [jobs, total] = await Promise.all([
    ImportJobModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<ImportJobDoc[]>(),
    ImportJobModel.countDocuments(filter),
  ]);
  return {
    items: jobs.map((j) => toPublicImport(j)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

/** `March batch 2026-10-09`, or `… (2)`, `… (3)` when that name is taken. */
const defaultListName = async (
  accountId: Types.ObjectId,
  fileName: string,
  timezone: string,
): Promise<string> => {
  const base = `${fileName.replace(/\.(csv|xlsx)$/i, '').slice(0, 80)} ${isoDay(new Date(), timezone)}`;
  for (let n = 1; n < 1000; n += 1) {
    const name = n === 1 ? base : `${base} (${n})`;
    const taken = await ContactListModel.exists({ accountId, name }).collation(NAME_COLLATION);
    if (!taken) return name;
  }
  /* c8 ignore next */
  return `${base} ${Date.now()}`;
};

const assertMappable = (job: ImportJobDoc) => {
  if (!(MAPPABLE as readonly string[]).includes(job.status)) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `This import is ${job.status} and can't be changed.`,
    );
  }
};

export const setMapping = async (
  req: Request,
  id: string,
  body: z.infer<typeof SetMappingBody>,
  storage: StorageProvider,
): Promise<PublicImportJob> => {
  const job = await findImport(req, id);
  assertMappable(job);
  const ctx = await loadContactContext(job.accountId);

  let sheetUpdate: Partial<ImportJobDoc> = {};
  if (body.sheet !== undefined && body.sheet !== job.sheet) {
    if (job.fileType !== 'xlsx')
      throw new ValidationError([{ path: 'sheet', message: 'Only .xlsx files have sheets' }]);
    const sheet = await parseSheet(
      await readStoredFile(storage, job.fileKey ?? ''),
      'xlsx',
      body.sheet,
    );
    sheetUpdate = {
      sheet: sheet.sheet,
      columns: columnsOf(sheet),
      rowCount: sheet.rows.length,
      warnings: sheet.warnings,
    };
  }
  if (body.columns.length === 0) {
    if (!sheetUpdate.sheet) {
      throw new ValidationError([{ path: 'columns', message: 'Map at least the phone column' }]);
    }
    // Sheet switch only: back to `uploaded` with the new sheet's columns.
    const switched = await ImportJobModel.findOneAndUpdate(
      { _id: job._id, accountId: job.accountId, status: { $in: MAPPABLE } },
      {
        $set: {
          ...sheetUpdate,
          status: 'uploaded',
          mapping: null,
          options: null,
          progress: { processed: 0, total: sheetUpdate.rowCount ?? 0 },
          totals: emptyImportTotals(),
          problemRows: [],
        },
      },
      { returnDocument: 'after' },
    ).lean<ImportJobDoc>();
    if (!switched)
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'The import changed meanwhile — reload it.',
      );
    return toPublicImport(switched, ctx);
  }
  const columnCount = (sheetUpdate.columns ?? job.columns).length;
  const mapping = { columns: body.columns as ColumnMapping[] };
  const errors = validateMapping(job.kind, mapping, columnCount, ctx.fields);

  let options: ImportOptions | null = null;
  if (job.kind === 'contacts') {
    const raw = body.options ?? {
      list: {
        mode: 'new' as const,
        name: await defaultListName(job.accountId, job.fileName, ctx.timezone),
      },
      updateExisting: true,
      tags: [],
    };
    const tags = normalizeTags(raw.tags);
    if (!tags.ok) errors.push({ path: 'options.tags', message: 'Invalid tag' });
    if (raw.list.mode === 'existing') {
      const exists = await ContactListModel.exists({
        _id: new Types.ObjectId(raw.list.listId),
        accountId: job.accountId,
      });
      if (!exists) errors.push({ path: 'options.list.listId', message: 'Unknown list' });
    } else {
      const taken = await ContactListModel.findOne({
        accountId: job.accountId,
        name: raw.list.name,
      })
        .collation(NAME_COLLATION)
        .select({ _id: 1 })
        .lean();
      if (taken) {
        errors.push({
          path: 'options.list.name',
          message: 'A list with this name exists — pick it as an existing list',
        });
      }
    }
    options = {
      list: raw.list,
      updateExisting: raw.updateExisting,
      tags: tags.ok ? tags.tags : [],
      consentSource: raw.consentSource ?? null,
    };
  }
  if (errors.length) throw new ValidationError(errors);

  await deleteQuietly(storage, job.errorReportKey);
  const total = sheetUpdate.rowCount ?? job.rowCount;
  const updated = await ImportJobModel.findOneAndUpdate(
    { _id: job._id, accountId: job.accountId, status: { $in: MAPPABLE } },
    {
      $set: {
        ...sheetUpdate,
        mapping,
        options,
        status: 'mapped',
        progress: { processed: 0, total },
        totals: emptyImportTotals(),
        problemRows: [],
        errorReportKey: null,
        errorMessage: null,
      },
    },
    { returnDocument: 'after' },
  ).lean<ImportJobDoc>();
  if (!updated)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The import changed meanwhile — reload it.');
  return toPublicImport(updated, ctx);
};

export const cancelImport = async (
  req: Request,
  id: string,
  storage: StorageProvider,
): Promise<PublicImportJob> => {
  const job = await findImport(req, id);
  if (job.status === 'importing') {
    const updated = await ImportJobModel.findOneAndUpdate(
      { _id: job._id, accountId: job.accountId, status: 'importing' },
      { $set: { cancelRequested: true } },
      { returnDocument: 'after' },
    ).lean<ImportJobDoc>();
    return toPublicImport(updated ?? job);
  }
  assertMappable(job);
  await deleteQuietly(storage, job.fileKey);
  await deleteQuietly(storage, job.errorReportKey);
  const updated = await ImportJobModel.findOneAndUpdate(
    { _id: job._id, accountId: job.accountId, status: { $in: MAPPABLE } },
    {
      $set: {
        status: 'canceled',
        canceledAt: new Date(),
        fileKey: null,
        errorReportKey: null,
        filesPurgedAt: new Date(),
        'columns.$[].samples': [],
      },
    },
    { returnDocument: 'after' },
  ).lean<ImportJobDoc>();
  if (!updated)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The import changed meanwhile — reload it.');
  return toPublicImport(updated);
};

const EXAMPLES = {
  text: 'Sample',
  number: '30',
  currency: 12_500_000_000,
  date: '2026-10-05',
  phone: '+919876543211',
};

/** CSV template: contact columns + every custom field, one example row (UTF-8 BOM). */
export const importTemplate = async (req: Request): Promise<string> => {
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  const header = ['name', 'phone', 'email', 'external_id', 'tags', ...ctx.fields.map((f) => f.key)];
  const example = [
    'Asha Verma',
    '+919876543210',
    'asha@example.com',
    'LN-1001',
    'vip',
    ...ctx.fields.map((f) => formatFieldValue(f.type, EXAMPLES[f.type])),
  ];
  const line = (cells: string[]) =>
    cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');
  return `\uFEFF${line(header)}\r\n${line(example)}\r\n`;
};

export const errorReportUrl = async (
  req: Request,
  id: string,
  storage: StorageProvider,
): Promise<{ url: string; expiresInSec: number }> => {
  const job = await findImport(req, id);
  if (!job.errorReportKey) throw new NotFoundError('This import has no error report');
  const expiresInSec = CONTACT_LIMITS.exportUrlTtlSec;
  return { url: await storage.signedUrl(job.errorReportKey, { expiresInSec }), expiresInSec };
};

const RUNNING_MESSAGE =
  'Another import is being checked or imported for this account — wait for it to finish.';

/** `mapped` / `validated` → `validating` + queued dry run (one per account at a time). */
export const startValidation = async (
  req: Request,
  id: string,
  jobs: ContactJobs,
): Promise<PublicImportJob> => {
  const job = await findImport(req, id);
  if (job.status !== 'mapped' && job.status !== 'validated') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      job.status === 'uploaded' ? 'Map the columns first.' : `This import is ${job.status}.`,
    );
  }
  const accountId = job.accountId.toString();
  const jobId = job._id.toString();
  if (!(await acquireJobLock('import', accountId, jobId))) {
    throw new ConflictError('CONFLICT_INVALID_STATE', RUNNING_MESSAGE);
  }
  try {
    const updated = await ImportJobModel.findOneAndUpdate(
      { _id: job._id, accountId: job.accountId, status: { $in: ['mapped', 'validated'] } },
      { $set: { status: 'validating', 'progress.processed': 0, 'progress.total': job.rowCount } },
      { returnDocument: 'after' },
    ).lean<ImportJobDoc>();
    if (!updated)
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'The import changed meanwhile — reload it.',
      );
    await jobs.enqueue('import.validate', { accountId, importJobId: jobId });
    return toPublicImport(updated);
  } catch (err) {
    await releaseJobLock('import', accountId, jobId);
    await ImportJobModel.updateOne(
      { _id: job._id, status: 'validating' },
      { $set: { status: job.status } },
    );
    throw err;
  }
};

/**
 * `validated` → `importing`: creates the mapping's new fields and the target
 * list in one transaction, then queues `import.run` (PHASE_3_PLAN T3.9).
 */
export const startImport = async (
  req: Request,
  id: string,
  jobs: ContactJobs,
): Promise<PublicImportJob> => {
  const job = await findImport(req, id);
  if (job.status !== 'validated') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Check the file first (validate), then start the import.',
    );
  }
  const accountId = job.accountId.toString();
  const jobId = job._id.toString();
  if (!(await acquireJobLock('import', accountId, jobId))) {
    throw new ConflictError('CONFLICT_INVALID_STATE', RUNNING_MESSAGE);
  }
  try {
    const ctx = await loadContactContext(job.accountId);
    const columns = (job.mapping as { columns: ColumnMapping[] }).columns;
    const options = job.options as ImportOptions | null;
    const newFields = columns.filter((c) => c.target === 'new_field');
    const clash = newFields.find((c) => ctx.byKey.has(c.key ?? ''));
    if (clash) {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        `A field "${clash.key ?? ''}" was created meanwhile — map the column to it and check again.`,
      );
    }
    if (ctx.fields.length + newFields.length > CONTACT_LIMITS.customFieldsPerAccount) {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'Too many custom fields for this account.');
    }

    const updated = await withTransaction(async (session) => {
      const maxOrder = Math.max(0, ...ctx.fields.map((f) => f.order));
      if (newFields.length) {
        await CustomFieldModel.create(
          newFields.map((c, i) => ({
            accountId: job.accountId,
            key: c.key,
            label: c.label,
            type: c.type,
            required: false,
            defaultValue: null,
            order: maxOrder + i + 1,
          })),
          { session, ordered: true },
        );
      }
      let listId: Types.ObjectId | null = null;
      if (job.kind === 'contacts' && options) {
        if (options.list.mode === 'existing') {
          listId = new Types.ObjectId(options.list.listId);
          const exists = await ContactListModel.exists({
            _id: listId,
            accountId: job.accountId,
          }).session(session);
          if (!exists)
            throw new ConflictError(
              'CONFLICT_INVALID_STATE',
              'The chosen list was deleted — pick another one.',
            );
        } else {
          const taken = await ContactListModel.findOne({
            accountId: job.accountId,
            name: options.list.name,
          })
            .collation(NAME_COLLATION)
            .session(session)
            .lean();
          if (taken)
            throw new ConflictError(
              'CONFLICT_DUPLICATE',
              'A list with this name exists now — pick it as an existing list.',
            );
          const [list] = await ContactListModel.create(
            [
              {
                accountId: job.accountId,
                name: options.list.name,
                source: { type: 'upload', fileName: job.fileName },
              },
            ],
            { session },
          );
          listId = list?._id ?? null;
        }
      }
      return ImportJobModel.findOneAndUpdate(
        { _id: job._id, accountId: job.accountId, status: 'validated' },
        {
          $set: {
            status: 'importing',
            startedAt: new Date(),
            listId,
            cancelRequested: false,
            progress: { processed: 0, total: job.rowCount },
            totals: emptyImportTotals(),
          },
        },
        { returnDocument: 'after', session },
      ).lean<ImportJobDoc>();
    });
    if (!updated)
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'The import changed meanwhile — reload it.',
      );
    await jobs.enqueue('import.run', { accountId, importJobId: jobId });
    await auditRequest(req, 'contacts.import_started', {
      target: { type: 'import_job', id: jobId },
      meta: { kind: job.kind, rows: job.rowCount },
    });
    return toPublicImport(updated);
  } catch (err) {
    await releaseJobLock('import', accountId, jobId);
    throw err;
  }
};
