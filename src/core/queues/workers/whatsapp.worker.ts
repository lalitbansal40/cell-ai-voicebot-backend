import type { Job, Queue, Worker } from 'bullmq';

import { WHATSAPP_LIMITS } from '../../../config/limits';
import { hasDeferredInboxEvents, runInboxBackfill } from '../../../modules/inbox/backfill.job';
import { importHistoryEvent } from '../../../modules/inbox/coexistence-import';
import type { InboxContext } from '../../../modules/inbox/context';
import { createInboxHooks } from '../../../modules/inbox/hooks';
import {
  INBOX_JOBS,
  queueInboxJobs,
  type HistoryImportJobData,
  type MessageJobData,
} from '../../../modules/inbox/jobs';
import { downloadInboundMedia } from '../../../modules/inbox/media.service';
import type { WhatsAppContext } from '../../../modules/whatsapp/context';
import { runHealthPass, WHATSAPP_HEALTH_CRON } from '../../../modules/whatsapp/health';
import {
  WEBHOOK_PROCESS_JOB,
  WHATSAPP_HEALTH_JOB,
  type WebhookJobData,
} from '../../../modules/whatsapp/jobs';
import type { HandlerContext } from '../../../modules/whatsapp/webhook-handlers';
import { processWebhookEvent } from '../../../modules/whatsapp/webhook-processor';
import { createWhatsAppService } from '../../../modules/whatsapp/whatsapp.service';
import type { StorageProvider } from '../../storage';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

/**
 * Job processor for queue `whatsapp`: webhook events, the daily health pass and
 * (Phase 10, with an inbox context) the inbox jobs.
 */
export const processWhatsAppJob =
  (h: HandlerContext, ix?: InboxContext) =>
  async (job: Job): Promise<unknown> => {
    const finalAttempt = () => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (job.name === WEBHOOK_PROCESS_JOB) {
      const { eventId } = job.data as WebhookJobData;
      return { status: await processWebhookEvent(h, eventId, { finalAttempt: finalAttempt() }) };
    }
    if (job.name === WHATSAPP_HEALTH_JOB) return runHealthPass(h.service);
    if (ix) {
      if (job.name === INBOX_JOBS.mediaDownload) {
        const { messageId } = job.data as MessageJobData;
        return {
          status: await downloadInboundMedia(ix, messageId, { finalAttempt: finalAttempt() }),
        };
      }
      if (job.name === INBOX_JOBS.backfill) return runInboxBackfill(ix);
      if (job.name === INBOX_JOBS.historyImport) {
        const { eventId } = job.data as HistoryImportJobData;
        return importHistoryEvent(ix, eventId);
      }
    }
    throw new Error(`Unknown whatsapp job "${job.name}"`);
  };

/** Starts the `whatsapp` worker + the daily health scheduler (only where `WHATSAPP_ENABLED`). */
export const startWhatsAppWorker = async (
  deps: QueueFactoryDeps & { ctx: WhatsAppContext; storage?: StorageProvider },
): Promise<{ queue: Queue; worker: Worker }> => {
  const queue = createQueue(QUEUES.whatsapp, deps);
  const ix: InboxContext | undefined = deps.storage
    ? { wa: deps.ctx, storage: deps.storage, jobs: queueInboxJobs(queue) }
    : undefined;
  const h: HandlerContext = {
    ctx: deps.ctx,
    service: createWhatsAppService(deps.ctx),
    ...(ix ? { inbox: createInboxHooks(ix) } : {}),
  };
  const worker = createWorker(QUEUES.whatsapp, processWhatsAppJob(h, ix), {
    ...deps,
    concurrency: WHATSAPP_LIMITS.workerConcurrency,
  });
  await queue.upsertJobScheduler(
    WHATSAPP_HEALTH_JOB,
    { pattern: WHATSAPP_HEALTH_CRON, tz: 'UTC' },
    { name: WHATSAPP_HEALTH_JOB },
  );
  // events stored as deferred before the inbox existed (or while it was off) → once
  if (ix && (await hasDeferredInboxEvents())) await ix.jobs.enqueueBackfill();
  return { queue, worker };
};
