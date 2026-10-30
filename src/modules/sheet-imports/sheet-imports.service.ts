import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { SHEET_IMPORT_LIMITS } from '../../config/limits';
import { ContactListModel } from '../../db/models/contact-list.model';
import { SheetImportModel, type SheetImportDoc } from '../../db/models/sheet-import.model';
import { actingUserId, requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { columnsOf } from '../contact-imports/contact-imports.service';
import { suggestMapping, validateMapping, type ColumnMapping } from '../contact-imports/mapping';
import { NAME_COLLATION } from '../contact-lists/contact-lists.service';
import { loadContactContext } from '../contacts/context';
import type { ContactJobs } from '../contacts/jobs';
import { normalizeTags } from '../contacts/normalize/tags';

import { fetchSheet } from './fetch';
import type { CreateSheetImportBody } from './sheet-imports.schema';

type SheetEnv = Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const sheetImportView = (s: SheetImportDoc, listName?: string) => ({
  id: s._id.toString(),
  name: s.name,
  schedule: s.schedule,
  mapping: s.mapping,
  listId: s.listId.toString(),
  listName: listName ?? null,
  updateExisting: s.updateExisting,
  tags: [...s.tags],
  active: s.active,
  nextRunAt: iso(s.nextRunAt),
  lastRunAt: iso(s.lastRunAt),
  lastStatus: s.lastStatus,
  lastError: s.lastError,
  lastResult: s.lastResult
    ? {
        importJobId: s.lastResult.importJobId ? s.lastResult.importJobId.toString() : null,
        rows: s.lastResult.rows,
        created: s.lastResult.created,
        updated: s.lastResult.updated,
        failed: s.lastResult.failed,
      }
    : null,
  createdAt: s.createdAt.toISOString(),
});

/** A free list name: `Google Sheet: <name>`, `… (2)` … */
const freeListName = async (accountId: Types.ObjectId, name: string) => {
  const base = `Google Sheet: ${name}`.slice(0, 95);
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base} (${String(n)})`;
    if (!(await ContactListModel.exists({ accountId, name: candidate }).collation(NAME_COLLATION)))
      return candidate;
  }
  /* c8 ignore next */
  return `${base} ${String(Date.now())}`;
};

/** The sheet's run key: `sheet-<id>-<runKey>` is the job id (never `:`). */
export const enqueueSheetRun = (
  jobs: ContactJobs,
  s: Pick<SheetImportDoc, '_id' | 'accountId'>,
  runKey: string,
) =>
  jobs.enqueue('sheets.import', {
    accountId: s.accountId.toString(),
    sheetImportId: s._id.toString(),
    runKey,
  });

/**
 * `POST /sheet-imports`: the published CSV is downloaded and parsed now (so a wrong
 * link or mapping fails here, not at 3 am), the mapping is checked against its
 * columns and the account's fields (existing fields only), a list "Google Sheet:
 * <name>" is created, and the first run is queued.
 */
export const createSheetImport = async (
  env: SheetEnv,
  jobs: ContactJobs,
  req: Request,
  body: z.infer<typeof CreateSheetImportBody>,
) => {
  const { accountId } = tenantFilter(req);
  if (
    (await SheetImportModel.countDocuments({ accountId })) >= SHEET_IMPORT_LIMITS.importsPerAccount
  ) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${String(SHEET_IMPORT_LIMITS.importsPerAccount)} Google Sheet imports.`,
    );
  }
  const { sheet } = await fetchSheet(env, body.url);
  const ctx = await loadContactContext(accountId);
  const mapping = { columns: body.mapping as ColumnMapping[] };
  const errors = validateMapping('contacts', mapping, columnsOf(sheet).length, ctx.fields);
  if (mapping.columns.some((c) => c.target === 'new_field'))
    errors.push({
      path: 'mapping',
      message: 'Create new fields first (Settings → Contact fields)',
    });
  const tags = normalizeTags(body.tags);
  if (!tags.ok) errors.push({ path: 'tags', message: 'Invalid tag' });
  if (errors.length) throw new ValidationError(errors);
  const auth = requireAuth(req);
  const [list] = await ContactListModel.create([
    {
      accountId,
      name: await freeListName(accountId, body.name),
      source: { type: 'upload', fileName: 'Google Sheet' },
    },
  ]);
  const created = await SheetImportModel.create({
    accountId,
    name: body.name,
    url: body.url,
    schedule: body.schedule,
    mapping,
    listId: list?._id,
    updateExisting: body.updateExisting,
    tags: tags.ok ? tags.tags : [],
    nextRunAt: new Date(),
    lastStatus: 'running',
    createdBy: new Types.ObjectId(actingUserId(auth)),
  });
  await enqueueSheetRun(jobs, created, String(Date.now()));
  await auditRequest(req, 'sheet_import.created', {
    target: { type: 'sheet_import', id: created._id.toString() },
    meta: { name: body.name, schedule: body.schedule, host: 'docs.google.com' },
  });
  return sheetImportView(created.toObject({ transform: false }), list?.name);
};

/**
 * `POST /sheet-imports/preview`: downloads the sheet to show its columns (header +
 * a few sample values, like the file-import wizard) and a suggested mapping
 * (existing fields only). Nothing is stored.
 */
export const previewSheet = async (env: SheetEnv, req: Request, url: string) => {
  const { sheet } = await fetchSheet(env, url);
  const ctx = await loadContactContext(tenantFilter(req).accountId);
  const columns = columnsOf(sheet);
  return {
    columns,
    rowCount: sheet.rows.length,
    suggestedMapping: suggestMapping('contacts', columns, ctx.fields, ctx.country).filter(
      (c) => c.target !== 'new_field',
    ),
  };
};

export const listSheetImports = async (req: Request) => {
  const { accountId } = tenantFilter(req);
  const rows = await SheetImportModel.find({ accountId })
    .sort({ createdAt: -1 })
    .lean<SheetImportDoc[]>();
  const lists = new Map(
    (
      await ContactListModel.find({ accountId, _id: { $in: rows.map((r) => r.listId) } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    ).map((l) => [l._id.toString(), l.name]),
  );
  return rows.map((r) => sheetImportView(r, lists.get(r.listId.toString())));
};

const findSheetImport = async (req: Request, id: string) => {
  const _id = toObjectId(id);
  const row = _id
    ? await SheetImportModel.findOne({ _id, ...tenantFilter(req) }).lean<SheetImportDoc>()
    : null;
  if (!row) throw new NotFoundError('Sheet import not found');
  return row;
};

/** Removes the schedule; imported contacts and their list stay. */
export const deleteSheetImport = async (req: Request, id: string) => {
  const row = await findSheetImport(req, id);
  await SheetImportModel.deleteOne({ _id: row._id, accountId: row.accountId });
  await auditRequest(req, 'sheet_import.deleted', {
    target: { type: 'sheet_import', id },
    meta: { name: row.name },
  });
};

/** `POST /sheet-imports/:id/run` — one more run now (one at a time). */
export const runSheetImportNow = async (jobs: ContactJobs, req: Request, id: string) => {
  const row = await findSheetImport(req, id);
  if (row.lastStatus === 'running')
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This sheet is being imported right now.');
  const updated = await SheetImportModel.findOneAndUpdate(
    { _id: row._id, lastStatus: { $ne: 'running' } },
    { $set: { lastStatus: 'running' } },
    { new: true },
  ).lean<SheetImportDoc>();
  if (!updated)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This sheet is being imported right now.');
  await enqueueSheetRun(jobs, row, String(Date.now()));
  return sheetImportView(updated);
};
