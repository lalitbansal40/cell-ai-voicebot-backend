import type { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel } from '../../db/models/contact.model';
import { ExportJobModel } from '../../db/models/export-job.model';
import { ImportJobModel } from '../../db/models/import-job.model';
import { deleteQuietly } from '../contact-imports/storage-io';

const DAY_MS = 86_400_000;
const BATCH = 1000;

/** Hard-deletes contacts (and lists) soft-deleted more than 30 days ago. */
export const purgeDeletedContacts = async (
  now = new Date(),
): Promise<{ contacts: number; lists: number }> => {
  const cutoff = new Date(now.getTime() - CONTACT_LIMITS.deletedContactRetentionDays * DAY_MS);
  let contacts = 0;
  for (;;) {
    const ids = (
      await ContactModel.find({ deletedAt: { $lt: cutoff } })
        .select({ _id: 1 })
        .limit(BATCH)
        .lean<{ _id: Types.ObjectId }[]>()
    ).map((c) => c._id);
    if (!ids.length) break;
    contacts += (await ContactModel.deleteMany({ _id: { $in: ids } })).deletedCount;
  }
  const lists = (await ContactListModel.deleteMany({ deletedAt: { $lt: cutoff } })).deletedCount;
  return { contacts, lists };
};

/** Deletes uploaded sheets, error reports and samples 30 days after the import ended. */
export const purgeImportFiles = async (
  storage: StorageProvider,
  now = new Date(),
): Promise<{ jobs: number }> => {
  const cutoff = new Date(now.getTime() - CONTACT_LIMITS.importFileRetentionDays * DAY_MS);
  const jobs = await ImportJobModel.find({
    filesPurgedAt: null,
    $or: [
      { completedAt: { $lt: cutoff } },
      { failedAt: { $lt: cutoff } },
      { canceledAt: { $lt: cutoff } },
    ],
  })
    .select({ fileKey: 1, errorReportKey: 1 })
    .lean<{ _id: Types.ObjectId; fileKey?: string | null; errorReportKey?: string | null }[]>();
  for (const job of jobs) {
    await deleteQuietly(storage, job.fileKey);
    await deleteQuietly(storage, job.errorReportKey);
    await ImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          fileKey: null,
          errorReportKey: null,
          filesPurgedAt: now,
          'columns.$[].samples': [],
        },
      },
    );
  }
  return { jobs: jobs.length };
};

/** Deletes export files 24 h after they were made (status → expired). */
export const purgeExportFiles = async (
  storage: StorageProvider,
  now = new Date(),
): Promise<{ jobs: number }> => {
  const jobs = await ExportJobModel.find({ status: 'ready', expiresAt: { $lt: now } })
    .select({ fileKey: 1 })
    .lean<{ _id: Types.ObjectId; fileKey?: string | null }[]>();
  for (const job of jobs) {
    await deleteQuietly(storage, job.fileKey);
    await ExportJobModel.updateOne(
      { _id: job._id },
      { $set: { status: 'expired', fileKey: null } },
    );
  }
  return { jobs: jobs.length };
};
