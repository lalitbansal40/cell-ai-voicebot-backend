import type { JobsOptions, Queue } from 'bullmq';

/** Background jobs on the `contacts` queue (PHASE_3_PLAN §1f). Job data = ids only (no PII in Redis). */
export interface ContactJobData {
  'import.validate': { accountId: string; importJobId: string };
  'import.run': { accountId: string; importJobId: string };
  'export.run': { accountId: string; exportJobId: string };
  'bulk.run': {
    accountId: string;
    actorUserId: string;
    impersonatorId?: string;
    action: string;
    filter: Record<string, unknown>;
    payload: Record<string, unknown>;
  };
  'field.delete_values': { accountId: string; key: string };
  'list.delete_members': { accountId: string; listId: string };
}

export type ContactJobName = keyof ContactJobData;

export const CONTACT_JOB_NAMES = [
  'import.validate',
  'import.run',
  'export.run',
  'bulk.run',
  'field.delete_values',
  'list.delete_members',
] as const satisfies readonly ContactJobName[];

export const isContactJobName = (value: string): value is ContactJobName =>
  (CONTACT_JOB_NAMES as readonly string[]).includes(value);

/** Enqueues contact jobs — the API depends on this interface, not on BullMQ. */
export interface ContactJobs {
  enqueue<N extends ContactJobName>(name: N, data: ContactJobData[N]): Promise<void>;
}

const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export const queueContactJobs = (queue: Queue): ContactJobs => ({
  async enqueue(name, data) {
    await queue.add(name, data, JOB_OPTIONS);
  },
});

/** Used when an app is built without a queue (tests that never enqueue). */
export const unavailableContactJobs: ContactJobs = {
  enqueue() {
    return Promise.reject(new Error('Contact jobs are not configured for this app'));
  },
};
