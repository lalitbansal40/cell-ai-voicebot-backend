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

/**
 * Graceful-close budget for all workers + queues. BullMQ's `close()` can hang
 * indefinitely when called while Redis is reconnecting (seen after a Redis
 * restart); the shutdown must still reach the email / redis / mongo hooks.
 * Jobs still active after the budget are picked up again by BullMQ's
 * stalled-job check on the next start.
 */
export const QUEUE_CLOSE_TIMEOUT_MS = 5_000;

/** Resolves `true` once `work` settles (resolved or rejected), `false` after `ms`. */
export const settleWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  const done = work.then(
    () => true,
    () => true, // close errors are emitted on the worker/queue 'error' events
  );
  const result = await Promise.race([done, timedOut]);
  clearTimeout(timer);
  return result;
};

/** Shutdown: workers first (active jobs finish), then queues — bounded by `timeoutMs`. */
export const closeAllQueues = async ({
  timeoutMs = QUEUE_CLOSE_TIMEOUT_MS,
  logger,
}: { timeoutMs?: number; logger?: Logger } = {}): Promise<void> => {
  const ws = [...workers];
  const qs = [...queues];
  workers.clear();
  queues.clear();
  const started = Date.now();
  const workersClosed = await settleWithin(Promise.all(ws.map((w) => w.close())), timeoutMs);
  if (!workersClosed) {
    logger?.warn(
      { timeoutMs, workers: ws.map((w) => w.name) },
      'queues: workers did not close in time — continuing shutdown',
    );
  }
  const remaining = Math.max(1_000, timeoutMs - (Date.now() - started));
  if (!(await settleWithin(Promise.all(qs.map((q) => q.close())), remaining))) {
    logger?.warn({ queues: qs.map((q) => q.name) }, 'queues: queues did not close in time');
  }
};
