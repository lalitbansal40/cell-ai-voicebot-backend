import type { JobsOptions, Queue } from 'bullmq';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { AppError } from '../../shared/errors/app-error';

/** Queue `whatsapp` job names. */
export const WEBHOOK_PROCESS_JOB = 'webhook.process';
export const WHATSAPP_HEALTH_JOB = 'whatsapp-health';

/** BullMQ job ids never contain `:`. */
export const webhookJobId = (eventId: string): string => `wa-event-${eventId}`;

export const WEBHOOK_JOB_OPTIONS: JobsOptions = {
  attempts: WHATSAPP_LIMITS.webhookProcessAttempts,
  backoff: { type: 'exponential', delay: WHATSAPP_LIMITS.webhookRetryBaseMs },
  removeOnComplete: { age: 86_400, count: 5000 },
  removeOnFail: { age: 7 * 86_400 },
};

export interface WebhookJobData {
  eventId: string;
}

export interface WhatsAppJobs {
  /** Enqueues processing of a stored webhook event (same id twice → one job). */
  enqueueEvent(eventId: string): Promise<void>;
}

export const queueWhatsAppJobs = (queue: Queue): WhatsAppJobs => ({
  async enqueueEvent(eventId) {
    await queue.add(WEBHOOK_PROCESS_JOB, { eventId } satisfies WebhookJobData, {
      ...WEBHOOK_JOB_OPTIONS,
      jobId: webhookJobId(eventId),
    });
  },
});

/** Where no queue runs (scripts): enqueueing fails loudly → the webhook answers 503. */
export const unavailableWhatsAppJobs: WhatsAppJobs = {
  enqueueEvent: () =>
    Promise.reject(new AppError('PROVIDER_UNAVAILABLE', 'The WhatsApp queue is not running.')),
};
