import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { CONTACT_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel } from '../../db/models/contact.model';
import { ExportJobModel, type ExportJobDoc } from '../../db/models/export-job.model';
import { SegmentModel } from '../../db/models/segment.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { compileContext, loadContactContext, type ContactContext } from '../contacts/context';
import { compileContactFilter, compileOrThrow } from '../contacts/filter/compile';
import type { ContactFilter } from '../contacts/filter/filter.schema';
import type { ContactJobs } from '../contacts/jobs';
import { acquireJobLock, releaseJobLock } from '../contacts/locks';

import {
  BASE_EXPORT_COLUMNS,
  type CreateExportBody,
  type ListExportsQuery,
} from './contact-exports.schema';

/** What an export job stores: explicit ids or a filter (lists / segments are resolved to a filter). */
export interface ExportSelection {
  ids?: string[];
  filter?: ContactFilter;
}

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

export const toPublicExport = (job: ExportJobDoc, downloadUrl?: string) => ({
  id: job._id.toString(),
  scope: job.scope,
  columns: [...job.columns],
  status: job.status,
  progress: { processed: job.progress.processed, total: job.progress.total },
  rowCount: job.rowCount,
  errorMessage: job.errorMessage ?? null,
  createdBy: job.createdBy.toString(),
  completedAt: iso(job.completedAt),
  expiresAt: iso(job.expiresAt),
  createdAt: job.createdAt.toISOString(),
  ...(downloadUrl ? { downloadUrl } : {}),
});

/** Selection → Mongo query (ids are checked against the account). */
export const selectionQuery = (
  ctx: ContactContext,
  selection: ExportSelection | undefined,
  strict: boolean,
): Record<string, unknown> => {
  if (selection?.ids) {
    return {
      accountId: ctx.accountId,
      deletedAt: null,
      _id: { $in: selection.ids.map((id) => new Types.ObjectId(id)) },
    };
  }
  const filter = selection?.filter ?? {};
  return strict
    ? compileOrThrow(ctx.accountId, filter, compileContext(ctx))
    : compileContactFilter(ctx.accountId, filter, compileContext(ctx)).query;
};

export const exportColumns = (ctx: ContactContext, requested?: string[]): string[] => {
  const all = [...BASE_EXPORT_COLUMNS, ...ctx.fields.map((f) => f.key)];
  if (!requested) return all;
  const unknown = requested.filter((c) => !all.includes(c));
  if (unknown.length)
    throw new ValidationError(
      unknown.map((c) => ({ path: 'columns', message: `Unknown column "${c}"` })),
    );
  return [...new Set(requested)];
};

export const createExport = async (
  req: Request,
  body: z.infer<typeof CreateExportBody>,
  jobs: ContactJobs,
) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  const ctx = await loadContactContext(accountId);
  let selection: ExportSelection;
  if (body.scope === 'ids') selection = { ids: [...new Set(body.ids ?? [])] };
  else if (body.scope === 'filter') selection = { filter: body.filter ?? {} };
  else if (body.scope === 'list') {
    const exists = await ContactListModel.exists({ _id: toObjectId(body.listId ?? ''), accountId });
    if (!exists) throw new NotFoundError('List not found');
    selection = { filter: { listIds: [body.listId as string] } };
  } else {
    const segment = await SegmentModel.findOne({
      _id: toObjectId(body.segmentId ?? ''),
      accountId,
    }).lean<{ filter: ContactFilter }>();
    if (!segment) throw new NotFoundError('Segment not found');
    selection = { filter: segment.filter };
  }
  const columns = exportColumns(ctx, body.columns);
  const query = selectionQuery(ctx, selection, body.scope === 'filter');
  const count = await ContactModel.countDocuments(query);
  if (selection.ids && count !== selection.ids.length)
    throw new NotFoundError('Some contacts were not found');
  if (count > CONTACT_LIMITS.exportMaxRows) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `This export would have ${count} rows — narrow it to at most ${CONTACT_LIMITS.exportMaxRows}.`,
    );
  }
  const _id = new Types.ObjectId();
  if (!(await acquireJobLock('export', accountId.toString(), _id.toString()))) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Another export is running — wait for it to finish.',
    );
  }
  try {
    const job = await ExportJobModel.create({
      _id,
      accountId,
      scope: body.scope,
      filter: selection as Record<string, unknown>,
      columns,
      status: 'pending',
      progress: { processed: 0, total: count },
      createdBy: new Types.ObjectId(auth.userId),
    });
    await jobs.enqueue('export.run', {
      accountId: accountId.toString(),
      exportJobId: _id.toString(),
    });
    return toPublicExport(job.toObject({ transform: false }));
  } catch (err) {
    await releaseJobLock('export', accountId.toString(), _id.toString());
    await ExportJobModel.deleteOne({ _id, status: 'pending' });
    throw err;
  }
};

export const listExports = async (req: Request, q: z.infer<typeof ListExportsQuery>) => {
  const filter = tenantFilter(req);
  const [jobs, total] = await Promise.all([
    ExportJobModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<ExportJobDoc[]>(),
    ExportJobModel.countDocuments(filter),
  ]);
  return {
    items: jobs.map((j) => toPublicExport(j)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

export const getExport = async (req: Request, id: string, storage: StorageProvider) => {
  const _id = toObjectId(id);
  const job = _id
    ? await ExportJobModel.findOne({ _id, ...tenantFilter(req) }).lean<ExportJobDoc>()
    : null;
  if (!job) throw new NotFoundError('Export not found');
  const ready =
    job.status === 'ready' && job.fileKey && job.expiresAt && job.expiresAt > new Date();
  const url = ready
    ? await storage.signedUrl(job.fileKey as string, {
        expiresInSec: CONTACT_LIMITS.exportUrlTtlSec,
      })
    : undefined;
  return toPublicExport(job, url);
};
