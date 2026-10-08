import type { Job, Queue, Worker } from 'bullmq';

import { purgeAuditLogs } from '../../../modules/audit/audit-purge';
import {
  purgeDeletedContacts,
  purgeExportFiles,
  purgeImportFiles,
} from '../../../modules/contacts/retention';
import type { StorageProvider } from '../../storage';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

export const AUDIT_PURGE_JOB = 'audit-purge';
/** Every day at 03:00 UTC. */
export const AUDIT_PURGE_CRON = '0 3 * * *';

export const CONTACTS_PURGE_JOB = 'contacts-purge';
export const IMPORT_FILES_PURGE_JOB = 'import-files-purge';
export const EXPORT_FILES_PURGE_JOB = 'export-files-purge';

/** Repeatable maintenance jobs (UTC crons). */
export const MAINTENANCE_SCHEDULES = [
  { name: AUDIT_PURGE_JOB, pattern: AUDIT_PURGE_CRON },
  { name: CONTACTS_PURGE_JOB, pattern: '15 3 * * *' },
  { name: IMPORT_FILES_PURGE_JOB, pattern: '30 3 * * *' },
  { name: EXPORT_FILES_PURGE_JOB, pattern: '0 * * * *' },
] as const;

export interface MaintenanceDeps extends Pick<QueueFactoryDeps, 'logger'> {
  storage?: StorageProvider;
}

const needStorage = (deps: MaintenanceDeps): StorageProvider => {
  if (!deps.storage) throw new Error('Maintenance job needs file storage');
  return deps.storage;
};

export const processMaintenanceJob =
  (deps: MaintenanceDeps) =>
  async (job: Job): Promise<Record<string, number>> => {
    let result: Record<string, number>;
    switch (job.name) {
      case AUDIT_PURGE_JOB:
        result = { deleted: await purgeAuditLogs() };
        break;
      case CONTACTS_PURGE_JOB:
        result = await purgeDeletedContacts();
        break;
      case IMPORT_FILES_PURGE_JOB:
        result = await purgeImportFiles(needStorage(deps));
        break;
      case EXPORT_FILES_PURGE_JOB:
        result = await purgeExportFiles(needStorage(deps));
        break;
      default:
        throw new Error(`Unknown maintenance job "${job.name}"`);
    }
    deps.logger.info({ job: job.name, ...result }, 'maintenance: done');
    return result;
  };

/** Starts the `maintenance` worker and schedules the purges. */
export const startMaintenanceWorker = async (
  deps: QueueFactoryDeps & { storage?: StorageProvider },
): Promise<{ queue: Queue; worker: Worker<unknown, Record<string, number>> }> => {
  const queue = createQueue(QUEUES.maintenance, deps);
  const worker = createWorker<unknown, Record<string, number>>(
    QUEUES.maintenance,
    processMaintenanceJob(deps),
    { ...deps, concurrency: 1 },
  );
  for (const s of MAINTENANCE_SCHEDULES) {
    await queue.upsertJobScheduler(s.name, { pattern: s.pattern, tz: 'UTC' }, { name: s.name });
  }
  return { queue, worker };
};
