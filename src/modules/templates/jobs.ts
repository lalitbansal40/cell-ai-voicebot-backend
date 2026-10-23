import type { Queue } from 'bullmq';

/**
 * Template jobs on the `whatsapp` queue (PHASE_11_PLAN §1a). Job data carries ids
 * only — never template text or variable values. BullMQ job ids never contain `:`.
 */
export const TEMPLATE_JOBS = {
  sync: 'template.sync',
  backfill: 'templates.backfill',
} as const;
export type TemplateJobName = (typeof TEMPLATE_JOBS)[keyof typeof TEMPLATE_JOBS];

export const TEMPLATE_SYNC_REASONS = ['connect', 'daily', 'manual', 'webhook'] as const;
export type TemplateSyncReason = (typeof TEMPLATE_SYNC_REASONS)[number];

export interface TemplateSyncJobData {
  channelId: string;
  reason: TemplateSyncReason;
}

/** One sync per number at a time (same id twice → one job). */
export const templateSyncJobId = (channelId: string): string => `template-sync-${channelId}`;
export const TEMPLATES_BACKFILL_JOB_ID = 'templates-backfill';

export const TEMPLATE_SYNC_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 86_400 },
} as const;

/** Daily scheduler on the `whatsapp` queue: one `template.sync` per WABA (04:10 IST). */
export const TEMPLATE_DAILY_SYNC_JOB = 'templates-daily-sync';
export const TEMPLATE_DAILY_SYNC_CRON = '40 22 * * *';

/** Enqueues template jobs (the API / webhooks depend on this, not on BullMQ). */
export interface TemplateJobs {
  enqueueSync(channelId: string, reason: TemplateSyncReason): Promise<void>;
  enqueueBackfill(): Promise<void>;
}

export const queueTemplateJobs = (queue: Queue): TemplateJobs => ({
  async enqueueSync(channelId, reason) {
    await queue.add(TEMPLATE_JOBS.sync, { channelId, reason } satisfies TemplateSyncJobData, {
      ...TEMPLATE_SYNC_JOB_OPTIONS,
      jobId: templateSyncJobId(channelId),
    });
  },
  async enqueueBackfill() {
    await queue.add(
      TEMPLATE_JOBS.backfill,
      {},
      { ...TEMPLATE_SYNC_JOB_OPTIONS, jobId: TEMPLATES_BACKFILL_JOB_ID },
    );
  },
});

/** Tests / scripts: records what would be queued. */
export const recordingTemplateJobs = (): TemplateJobs & {
  syncs: TemplateSyncJobData[];
  backfills: number;
} => {
  const jobs = {
    syncs: [] as TemplateSyncJobData[],
    backfills: 0,
    enqueueSync(channelId: string, reason: TemplateSyncReason) {
      jobs.syncs.push({ channelId, reason });
      return Promise.resolve();
    },
    enqueueBackfill() {
      jobs.backfills += 1;
      return Promise.resolve();
    },
  };
  return jobs;
};

/** Where no queue runs (scripts / tests without one): queueing is skipped (the daily sync catches up). */
export const unavailableTemplateJobs: TemplateJobs = {
  enqueueSync: () => Promise.resolve(),
  enqueueBackfill: () => Promise.resolve(),
};
