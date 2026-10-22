import type { Job, Queue, Worker } from 'bullmq';

import { getEnv } from '../../../config/env';
import { purgeAuditLogs } from '../../../modules/audit/audit-purge';
import { purgeCalls, reapCalls } from '../../../modules/calls/maintenance';
import { CallRegistry } from '../../../modules/calls/registry';
import {
  purgeDeletedContacts,
  purgeExportFiles,
  purgeImportFiles,
} from '../../../modules/contacts/retention';
import { purgeDeletedAudio } from '../../../modules/flow-audio/flow-audio.service';
import { purgeDeletedFlows } from '../../../modules/flows/maintenance';
import { purgeWebhookEvents } from '../../../modules/whatsapp/webhook-processor';
import type { StorageProvider } from '../../storage';
import { purgeTtsCache } from '../../voice/tts-cache';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';
import { getAppRedis } from '../redis';

export const AUDIT_PURGE_JOB = 'audit-purge';
/** Every day at 03:00 UTC. */
export const AUDIT_PURGE_CRON = '0 3 * * *';

export const CONTACTS_PURGE_JOB = 'contacts-purge';
export const IMPORT_FILES_PURGE_JOB = 'import-files-purge';
export const EXPORT_FILES_PURGE_JOB = 'export-files-purge';
/** Soft-deleted flows after 30 days (Phase 6). */
export const FLOWS_PURGE_JOB = 'flows-purge';
/** Calls of a dead process (Phase 7). */
export const CALLS_REAPER_JOB = 'calls-reaper';
export const CALLS_PURGE_JOB = 'calls-purge';
export const TTS_CACHE_PURGE_JOB = 'tts-cache-purge';
/** Expired Meta webhook events (backup of the TTL index, Phase 9). */
export const WHATSAPP_EVENTS_PURGE_JOB = 'whatsapp-events-purge';

/** Repeatable maintenance jobs (UTC crons). */
export const MAINTENANCE_SCHEDULES = [
  { name: AUDIT_PURGE_JOB, pattern: AUDIT_PURGE_CRON },
  { name: CONTACTS_PURGE_JOB, pattern: '15 3 * * *' },
  { name: IMPORT_FILES_PURGE_JOB, pattern: '30 3 * * *' },
  { name: EXPORT_FILES_PURGE_JOB, pattern: '0 * * * *' },
  { name: FLOWS_PURGE_JOB, pattern: '45 4 * * *' },
  { name: CALLS_REAPER_JOB, pattern: '*/1 * * * *' },
  { name: CALLS_PURGE_JOB, pattern: '10 5 * * *' },
  { name: TTS_CACHE_PURGE_JOB, pattern: '20 5 * * *' },
  { name: WHATSAPP_EVENTS_PURGE_JOB, pattern: '40 5 * * *' },
] as const;

export interface MaintenanceDeps extends Pick<QueueFactoryDeps, 'logger'> {
  storage?: StorageProvider;
  /** Live-call registry (calls reaper); default from REDIS_URL. */
  registry?: CallRegistry;
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
      case FLOWS_PURGE_JOB:
        result = {
          ...(await purgeDeletedFlows()),
          ...(deps.storage ? await purgeDeletedAudio(deps.storage) : {}),
        };
        break;
      case CALLS_REAPER_JOB:
        result = await reapCalls(
          deps.registry ?? new CallRegistry(getAppRedis(getEnv().REDIS_URL, deps.logger)),
          deps.logger,
        );
        break;
      case CALLS_PURGE_JOB:
        result = await purgeCalls(deps.storage, getEnv().CALL_RETENTION_DAYS);
        break;
      case TTS_CACHE_PURGE_JOB:
        result = await purgeTtsCache(needStorage(deps));
        break;
      case WHATSAPP_EVENTS_PURGE_JOB:
        result = await purgeWebhookEvents();
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
