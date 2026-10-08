import type { Job, Queue, Worker } from 'bullmq';

import { purgeAuditLogs } from '../../../modules/audit/audit-purge';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

export const AUDIT_PURGE_JOB = 'audit-purge';
/** Every day at 03:00 UTC. */
export const AUDIT_PURGE_CRON = '0 3 * * *';

export const processMaintenanceJob =
  (deps: Pick<QueueFactoryDeps, 'logger'>) =>
  async (job: Job): Promise<{ deleted: number }> => {
    if (job.name !== AUDIT_PURGE_JOB) throw new Error(`Unknown maintenance job "${job.name}"`);
    const deleted = await purgeAuditLogs();
    deps.logger.info({ deleted }, 'maintenance: audit purge done');
    return { deleted };
  };

/** Starts the `maintenance` worker and schedules the daily audit purge. */
export const startMaintenanceWorker = async (
  deps: QueueFactoryDeps,
): Promise<{ queue: Queue; worker: Worker<unknown, { deleted: number }> }> => {
  const queue = createQueue(QUEUES.maintenance, deps);
  const worker = createWorker<unknown, { deleted: number }>(
    QUEUES.maintenance,
    processMaintenanceJob(deps),
    { ...deps, concurrency: 1 },
  );
  await queue.upsertJobScheduler(
    AUDIT_PURGE_JOB,
    { pattern: AUDIT_PURGE_CRON, tz: 'UTC' },
    { name: AUDIT_PURGE_JOB },
  );
  return { queue, worker };
};
