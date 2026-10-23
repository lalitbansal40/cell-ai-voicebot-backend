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
