import type { Job, Queue, Worker } from 'bullmq';

import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

export interface HeartbeatResult {
  ok: true;
  at: string;
}

export const HEARTBEAT_JOB = 'heartbeat';
export const HEARTBEAT_EVERY_MS = 5 * 60_000;

/** No-op processor proving the queue wiring end to end. */
// eslint-disable-next-line @typescript-eslint/require-await -- async so errors surface as rejections
export const processSystemJob = async (job: Job): Promise<HeartbeatResult> => {
  if (job.name !== HEARTBEAT_JOB) throw new Error(`Unknown system job "${job.name}"`);
  return { ok: true, at: new Date().toISOString() };
};

/** Starts the `system` worker and schedules a cheap heartbeat (every 5 min + one now). */
export const startSystemWorker = async (
  deps: QueueFactoryDeps,
): Promise<{ queue: Queue; worker: Worker<unknown, HeartbeatResult> }> => {
  const queue = createQueue(QUEUES.system, deps);
  const worker = createWorker<unknown, HeartbeatResult>(QUEUES.system, processSystemJob, deps);
  await queue.upsertJobScheduler(
    'system-heartbeat',
    { every: HEARTBEAT_EVERY_MS },
    { name: HEARTBEAT_JOB },
  );
  await queue.add(HEARTBEAT_JOB, {});
  return { queue, worker };
};
