import type { Job, Queue, Worker } from 'bullmq';

import {
  BILLING_SCHEDULES,
  isBillingJobName,
  type BillingJobData,
  type BillingJobName,
  type BillingJobs,
} from '../../billing/jobs';
import type { StorageProvider } from '../../storage';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

export interface BillingJobContext {
  storage?: StorageProvider;
  jobs: BillingJobs;
  logger: QueueFactoryDeps['logger'];
}

export type BillingJobHandler<N extends BillingJobName = BillingJobName> = (
  data: BillingJobData[N],
  ctx: BillingJobContext,
  job: Job,
) => Promise<unknown>;

export type BillingJobHandlers = { [N in BillingJobName]?: BillingJobHandler<N> };

/** Processors per job name — each Phase 4 task registers its own here. */
export const BILLING_JOB_HANDLERS: BillingJobHandlers = {};

export const processBillingJob =
  (ctx: BillingJobContext, handlers: BillingJobHandlers = BILLING_JOB_HANDLERS) =>
  async (job: Job): Promise<unknown> => {
    const handler = isBillingJobName(job.name) ? handlers[job.name] : undefined;
    if (!handler) throw new Error(`Unknown billing job "${job.name}"`);
    return (handler as BillingJobHandler)(job.data as never, ctx, job);
  };

/** Starts the `billing` worker and schedules the repeatable billing jobs. */
export const startBillingWorker = async (
  deps: QueueFactoryDeps & { storage?: StorageProvider; jobs: BillingJobs },
): Promise<{ queue: Queue; worker: Worker }> => {
  const ctx: BillingJobContext = { storage: deps.storage, jobs: deps.jobs, logger: deps.logger };
  const queue = createQueue(QUEUES.billing, deps);
  const worker = createWorker(QUEUES.billing, processBillingJob(ctx), { ...deps, concurrency: 2 });
  for (const s of BILLING_SCHEDULES) {
    await queue.upsertJobScheduler(s.name, { pattern: s.pattern, tz: 'UTC' }, { name: s.name });
  }
  return { queue, worker };
};
