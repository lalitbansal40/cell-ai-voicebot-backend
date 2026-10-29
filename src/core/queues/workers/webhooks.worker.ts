import type { Job, Queue, Worker } from 'bullmq';

import { deliverWebhook, type WebhookRuntime } from '../../../modules/webhooks/deliver.job';
import { WEBHOOK_JOBS, type WebhookDeliverJobData } from '../../../modules/webhooks/jobs';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

/** Parallel deliveries per process: a slow receiver holds one slot, never the queue. */
export const WEBHOOK_WORKER_CONCURRENCY = 20;

export const processWebhookJob =
  (rt: WebhookRuntime) =>
  async (job: Job): Promise<{ status: string }> => {
    if (job.name !== WEBHOOK_JOBS.deliver) throw new Error(`Unknown webhook job "${job.name}"`);
    return deliverWebhook(rt, job.data as WebhookDeliverJobData);
  };

/** Starts the `webhooks` worker (Phase 15). */
export const startWebhooksWorker = (
  deps: QueueFactoryDeps & { runtime: WebhookRuntime },
): { queue: Queue; worker: Worker } => {
  const queue = createQueue(QUEUES.webhooks, deps);
  const worker = createWorker(QUEUES.webhooks, processWebhookJob(deps.runtime), {
    ...deps,
    concurrency: WEBHOOK_WORKER_CONCURRENCY,
  });
  return { queue, worker };
};
