import type { Request } from 'express';
import { Types } from 'mongoose';

import type { StorageProvider } from '../../core/storage';
import { AccountExportModel, type AccountExportDoc } from '../../db/models/account-export.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { verifyPassword } from '../auth/password';
import type { ContactJobs } from '../contacts/jobs';

const LINK_SECONDS = 24 * 60 * 60;

/** Big actions ask for the password again. */
export const assertPassword = async (req: Request, password: string): Promise<void> => {
  const user = await UserModel.findById(requireAuth(req).userId)
    .select('+passwordHash')
    .lean<UserDoc>();
  const hash = user?.passwordHash;
  if (!hash || !(await verifyPassword(hash, password)).ok) throw new AppError('REAUTH_FAILED');
};

const toView = (e: AccountExportDoc) => ({
  id: e._id.toString(),
  status: e.status,
  includeRecordings: e.includeRecordings,
  sizeBytes: e.sizeBytes,
  counts: e.counts,
  expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
  createdAt: e.createdAt.toISOString(),
});

export const requestAccountExport = async (
  req: Request,
  body: { password: string; includeRecordings?: boolean | undefined },
  jobs: ContactJobs,
) => {
  await assertPassword(req, body.password);
  const { accountId } = tenantFilter(req);
  const running = await AccountExportModel.exists({
    accountId,
    status: { $in: ['queued', 'running'] },
  });
  if (running) throw new AppError('ACCOUNT_EXPORT_IN_PROGRESS');
  const created = await AccountExportModel.create({
    accountId,
    requestedBy: new Types.ObjectId(requireAuth(req).userId),
    includeRecordings: body.includeRecordings === true,
  });
  await jobs.enqueue('account.export', {
    accountId: accountId.toString(),
    accountExportId: created._id.toString(),
  });
  await auditRequest(req, 'account.export_requested', {
    target: { type: 'account_export', id: created._id.toString() },
    meta: { includeRecordings: created.includeRecordings },
  });
  return toView(created.toObject({ transform: false }));
};

export const listAccountExports = async (req: Request) => {
  const rows = await AccountExportModel.find(tenantFilter(req))
    .sort({ createdAt: -1 })
    .limit(20)
    .lean<AccountExportDoc[]>();
  return rows.map(toView);
};

/** One export; when it's ready, with a download link valid for 24 hours. */
export const getAccountExport = async (req: Request, id: string, storage: StorageProvider) => {
  const _id = toObjectId(id);
  const row = _id
    ? await AccountExportModel.findOne({ _id, ...tenantFilter(req) }).lean<AccountExportDoc>()
    : null;
  if (!row) throw new NotFoundError();
  if (row.status !== 'ready' || !row.fileKey) return { ...toView(row), url: null };
  const url = await storage.signedUrl(row.fileKey, {
    expiresInSec: LINK_SECONDS,
    downloadName: `account-export-${row._id.toString()}.zip`,
  });
  await auditRequest(req, 'account.export_downloaded', {
    target: { type: 'account_export', id: row._id.toString() },
  });
  return { ...toView(row), url };
};
