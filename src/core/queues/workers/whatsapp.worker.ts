import { DelayedError, type Job, type Queue, type Worker } from 'bullmq';

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
import { processReadReceipt } from '../../../modules/inbox/receipts';
import { processSend } from '../../../modules/inbox/send.job';
import {
  hasDeferredTemplateEvents,
  runTemplatesBackfill,
} from '../../../modules/templates/backfill.job';
import type { TemplateContext } from '../../../modules/templates/context';
import {
  queueTemplateJobs,
  TEMPLATE_DAILY_SYNC_CRON,
  TEMPLATE_DAILY_SYNC_JOB,
  TEMPLATE_JOBS,
  type TemplateSyncJobData,
} from '../../../modules/templates/jobs';
import { processTemplateSync, queueDailyTemplateSyncs } from '../../../modules/templates/sync.job';
import { createTemplateHooks } from '../../../modules/templates/webhooks';
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
  (h: HandlerContext, ix?: InboxContext, tx?: TemplateContext) =>
  async (job: Job, token?: string): Promise<unknown> => {
    const finalAttempt = () => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (job.name === WEBHOOK_PROCESS_JOB) {
      const { eventId } = job.data as WebhookJobData;
      return { status: await processWebhookEvent(h, eventId, { finalAttempt: finalAttempt() }) };
    }
    if (job.name === WHATSAPP_HEALTH_JOB) return runHealthPass(h.service);
    if (tx) {
      if (job.name === TEMPLATE_JOBS.sync) {
        return processTemplateSync(tx, job.data as TemplateSyncJobData);
      }
      if (job.name === TEMPLATE_JOBS.backfill) return runTemplatesBackfill(tx);
      if (job.name === TEMPLATE_DAILY_SYNC_JOB) return queueDailyTemplateSyncs(tx);
    }
    if (ix) {
      if (job.name === INBOX_JOBS.mediaDownload) {
        const { messageId } = job.data as MessageJobData;
        return {
          status: await downloadInboundMedia(ix, messageId, { finalAttempt: finalAttempt() }),
        };
      }
      if (job.name === INBOX_JOBS.messageSend) {
        const data = job.data as MessageJobData & { waits?: number };
        const waits = data.waits ?? 0;
        const outcome = await processSend(ix, data.messageId, {
          finalAttempt: finalAttempt(),
          waits,
        });
        if (outcome.kind === 'wait' || outcome.kind === 'later') {
          // an earlier message first / Meta asked to slow down: later, without using an attempt
          await job.updateData({ ...data, waits: waits + 1 });
          await job.moveToDelayed(Date.now() + outcome.delayMs, token);
          throw new DelayedError();
        }
        return outcome;
      }
      if (job.name === INBOX_JOBS.readReceipt) {
        const { messageId } = job.data as MessageJobData;
        return {
          status: await processReadReceipt(ix, messageId, { finalAttempt: finalAttempt() }),
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
  const tx: TemplateContext = {
    wa: deps.ctx,
    jobs: queueTemplateJobs(queue),
    ...(deps.storage ? { storage: deps.storage } : {}),
  };
  const h: HandlerContext = {
    ctx: deps.ctx,
    service: createWhatsAppService(deps.ctx),
    ...(ix ? { inbox: createInboxHooks(ix) } : {}),
    templates: createTemplateHooks(tx),
  };
  const worker = createWorker(QUEUES.whatsapp, processWhatsAppJob(h, ix, tx), {
    ...deps,
    concurrency: WHATSAPP_LIMITS.workerConcurrency,
  });
  await queue.upsertJobScheduler(
    WHATSAPP_HEALTH_JOB,
    { pattern: WHATSAPP_HEALTH_CRON, tz: 'UTC' },
    { name: WHATSAPP_HEALTH_JOB },
  );
  // Phase 11: one template sync per WABA every day (04:10 IST)
  await queue.upsertJobScheduler(
    TEMPLATE_DAILY_SYNC_JOB,
    { pattern: TEMPLATE_DAILY_SYNC_CRON, tz: 'UTC' },
    { name: TEMPLATE_DAILY_SYNC_JOB },
  );
  // events stored as deferred before the inbox existed (or while it was off) → once
  if (ix && (await hasDeferredInboxEvents())) await ix.jobs.enqueueBackfill();
  // template events stored before Phase 11 → once
  if (await hasDeferredTemplateEvents()) await tx.jobs.enqueueBackfill();
  return { queue, worker };
};
