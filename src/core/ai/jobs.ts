import type { JobsOptions, Queue } from 'bullmq';

/** Background jobs on the `ai` queue (PHASE_5_PLAN §1d / §1f). Job data = ids only. */
export interface AiJobData {
  'kb.ingest': { accountId: string; kbId: string; sourceId: string; version: number };
  'kb.reindex': { accountId: string; kbId: string };
  'playground.purge': Record<string, never>;
  'agents.purge_deleted': Record<string, never>;
}

export type AiJobName = keyof AiJobData;

export const AI_JOB_NAMES = [
  'kb.ingest',
  'kb.reindex',
  'playground.purge',
  'agents.purge_deleted',
] as const satisfies readonly AiJobName[];

export const isAiJobName = (value: string): value is AiJobName =>
  (AI_JOB_NAMES as readonly string[]).includes(value);

/** Repeatable AI jobs (UTC crons). */
export const AI_SCHEDULES = [
  { name: 'playground.purge', pattern: '30 3 * * *' },
  { name: 'agents.purge_deleted', pattern: '15 4 * * *' },
] as const satisfies readonly { name: AiJobName; pattern: string }[];

/** Enqueues AI jobs — the API depends on this interface, not on BullMQ. */
export interface AiJobs {
  enqueue<N extends AiJobName>(name: N, data: AiJobData[N]): Promise<void>;
}

const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const queueAiJobs = (queue: Queue): AiJobs => ({
  async enqueue(name, data) {
    await queue.add(name, data, JOB_OPTIONS);
  },
});

/** Used when an app is built without a queue (tests that never enqueue). */
export const unavailableAiJobs: AiJobs = {
  enqueue() {
    return Promise.reject(new Error('AI jobs are not configured for this app'));
  },
};
