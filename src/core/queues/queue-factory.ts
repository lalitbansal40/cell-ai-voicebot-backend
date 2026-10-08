import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';

import type { Logger } from '../../shared/logger';

import { createRedis } from './redis';

/** Defaults for every job (override per add()). */
export const QUEUE_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 604_800 },
};

export const DEFAULT_QUEUE_PREFIX = 'cav';

export interface QueueFactoryDeps {
  redisUrl: string;
  logger: Logger;
  /** BullMQ key prefix — tests pass a unique one. */
  prefix?: string;
}

const workers = new Set<Worker>();
const queues = new Set<Queue>();

export const createQueue = <Data = unknown>(name: string, deps: QueueFactoryDeps): Queue<Data> => {
  const queue = new Queue<Data>(name, {
    connection: createRedis(deps.redisUrl, `queue:${name}`, deps.logger),
    prefix: deps.prefix ?? DEFAULT_QUEUE_PREFIX,
    defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS,
  });
  queues.add(queue as Queue);
  return queue;
};

export const createWorker = <Data = unknown, Result = unknown>(
  name: string,
  processor: Processor<Data, Result>,
  deps: QueueFactoryDeps & { concurrency?: number },
): Worker<Data, Result> => {
  const worker = new Worker<Data, Result>(name, processor, {
    connection: createRedis(deps.redisUrl, `worker:${name}`, deps.logger),
    prefix: deps.prefix ?? DEFAULT_QUEUE_PREFIX,
    concurrency: deps.concurrency ?? 5,
  });
  worker.on('failed', (job, err) => {
    deps.logger.warn(
      { queue: name, jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err },
      'job failed',
    );
  });
  worker.on('error', (err) => {
    deps.logger.error({ queue: name, err }, 'worker error');
  });
  workers.add(worker as Worker);
  return worker;
};

/** Shutdown: workers first (active jobs finish), then queues. */
export const closeAllQueues = async (): Promise<void> => {
  const ws = [...workers];
  const qs = [...queues];
  workers.clear();
  queues.clear();
  await Promise.all(ws.map((w) => w.close()));
  await Promise.all(qs.map((q) => q.close()));
};
