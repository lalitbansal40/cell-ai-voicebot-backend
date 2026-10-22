import type { Job, Queue, Worker } from 'bullmq';

import { WHATSAPP_LIMITS } from '../../../config/limits';
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
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

/** Job processor for queue `whatsapp`: webhook events and the daily health pass. */
export const processWhatsAppJob =
  (h: HandlerContext) =>
  async (job: Job): Promise<unknown> => {
    if (job.name === WEBHOOK_PROCESS_JOB) {
      const { eventId } = job.data as WebhookJobData;
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return { status: await processWebhookEvent(h, eventId, { finalAttempt }) };
    }
    if (job.name === WHATSAPP_HEALTH_JOB) return runHealthPass(h.service);
    throw new Error(`Unknown whatsapp job "${job.name}"`);
  };

/** Starts the `whatsapp` worker + the daily health scheduler (only where `WHATSAPP_ENABLED`). */
export const startWhatsAppWorker = async (
  deps: QueueFactoryDeps & { ctx: WhatsAppContext },
): Promise<{ queue: Queue; worker: Worker }> => {
  const queue = createQueue(QUEUES.whatsapp, deps);
  const h: HandlerContext = { ctx: deps.ctx, service: createWhatsAppService(deps.ctx) };
  const worker = createWorker(QUEUES.whatsapp, processWhatsAppJob(h), {
    ...deps,
    concurrency: WHATSAPP_LIMITS.workerConcurrency,
  });
  await queue.upsertJobScheduler(
    WHATSAPP_HEALTH_JOB,
    { pattern: WHATSAPP_HEALTH_CRON, tz: 'UTC' },
    { name: WHATSAPP_HEALTH_JOB },
  );
  return { queue, worker };
};
