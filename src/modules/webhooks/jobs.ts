import type { Queue } from 'bullmq';

/** Background jobs on the `webhooks` queue (Phase 15). Job data = ids only. */
export const WEBHOOK_JOBS = { deliver: 'webhooks.deliver' } as const;

export interface WebhookDeliverJobData {
  deliveryId: string;
  attempt: number;
  /** A manual replay: one attempt, never retried. */
  replay?: boolean;
}

export interface WebhookJobs {
  enqueueDelivery(
    deliveryId: string,
    attempt: number,
    delayMs: number,
    replay?: boolean,
  ): Promise<void>;
}

/** Job ids never contain `:` (BullMQ). */
export const deliverJobId = (deliveryId: string, attempt: number): string =>
  `wh-${deliveryId}-${String(attempt)}`;

export const queueWebhookJobs = (queue: Queue): WebhookJobs => ({
  async enqueueDelivery(deliveryId, attempt, delayMs, replay = false) {
    await queue.add(
      WEBHOOK_JOBS.deliver,
      { deliveryId, attempt, ...(replay ? { replay } : {}) } satisfies WebhookDeliverJobData,
      {
        jobId: deliverJobId(deliveryId, attempt),
        delay: Math.max(0, delayMs),
        // retries are our own schedule (next attempt = a new job), never BullMQ's
        attempts: 1,
        removeOnComplete: { age: 86_400, count: 5_000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    );
  },
});

/** Records the jobs (tests, and apps without a worker set). */
export const recordingWebhookJobs = (): WebhookJobs & {
  queued: { deliveryId: string; attempt: number; delayMs: number; replay: boolean }[];
} => {
  const queued: { deliveryId: string; attempt: number; delayMs: number; replay: boolean }[] = [];
  return {
    queued,
    enqueueDelivery(deliveryId, attempt, delayMs, replay = false) {
      queued.push({ deliveryId, attempt, delayMs, replay });
      return Promise.resolve();
    },
  };
};

let current: WebhookJobs = { enqueueDelivery: () => Promise.resolve() };

/** The server sets the queue-backed jobs at start; tests set recording jobs. */
export const setWebhookJobs = (jobs: WebhookJobs): void => {
  current = jobs;
};
export const getWebhookJobs = (): WebhookJobs => current;
