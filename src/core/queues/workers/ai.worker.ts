import type { Job, Queue, Worker } from 'bullmq';

import {
  purgeDeletedAgents,
  purgePlaygroundSessions,
} from '../../../modules/ai-agents/maintenance';
import {
  AI_SCHEDULES,
  isAiJobName,
  type AiJobData,
  type AiJobName,
  type AiJobs,
} from '../../ai/jobs';
import type { AiProvider } from '../../ai/types';
import type { StorageProvider } from '../../storage';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

export interface AiJobContext {
  storage?: StorageProvider;
  provider?: AiProvider;
  jobs: AiJobs;
  logger: QueueFactoryDeps['logger'];
}

export type AiJobHandler<N extends AiJobName = AiJobName> = (
  data: AiJobData[N],
  ctx: AiJobContext,
  job: Job,
) => Promise<unknown>;

export type AiJobHandlers = { [N in AiJobName]?: AiJobHandler<N> };

/** Processors per job name — each Phase 5 task registers its own here. */
export const AI_JOB_HANDLERS: AiJobHandlers = {
  'playground.purge': () => purgePlaygroundSessions(),
  'agents.purge_deleted': () => purgeDeletedAgents(),
};

export const processAiJob =
  (ctx: AiJobContext, handlers: AiJobHandlers = AI_JOB_HANDLERS) =>
  async (job: Job): Promise<unknown> => {
    const handler = isAiJobName(job.name) ? handlers[job.name] : undefined;
    if (!handler) throw new Error(`Unknown AI job "${job.name}"`);
    return (handler as AiJobHandler)(job.data as never, ctx, job);
  };

/** Starts the `ai` worker and schedules the repeatable AI jobs. */
export const startAiWorker = async (
  deps: QueueFactoryDeps & { storage?: StorageProvider; provider?: AiProvider; jobs: AiJobs },
): Promise<{ queue: Queue; worker: Worker }> => {
  const ctx: AiJobContext = {
    storage: deps.storage,
    provider: deps.provider,
    jobs: deps.jobs,
    logger: deps.logger,
  };
  const queue = createQueue(QUEUES.ai, deps);
  const worker = createWorker(QUEUES.ai, processAiJob(ctx), { ...deps, concurrency: 2 });
  for (const s of AI_SCHEDULES) {
    await queue.upsertJobScheduler(s.name, { pattern: s.pattern, tz: 'UTC' }, { name: s.name });
  }
  return { queue, worker };
};
