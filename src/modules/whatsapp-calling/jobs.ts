/**
 * WhatsApp calling jobs (PHASE_12_PROMPT §1). `whatsapp` queue unless noted; job
 * data carries ids only — never phones, names or SDP. BullMQ job ids never contain `:`.
 * The processors are wired by the tasks that implement them (T12.5 / T12.7).
 */
export const CALLING_JOBS = {
  /** Hourly: temporary permissions past `expiresAt` → `expired` (the unanswered streak is kept). */
  permissionSweep: 'whatsapp.call_permission_sweep',
  /** Daily + after a connect + on `account_settings_update`: Meta's call settings → our row. */
  settingsSync: 'whatsapp.calling_settings_sync',
  /** Worker start, once: `calls` events stored before Phase 12 → consumed `ignored_stale`. */
  backfillIgnore: 'whatsapp.calls_backfill_ignore',
} as const;
export type CallingJobName = (typeof CALLING_JOBS)[keyof typeof CALLING_JOBS];

/** `billing` queue: WhatsApp call holds older than `maxCallSecHard` + 15 min whose call is final. */
export const WHATSAPP_CALL_REAP_JOB = 'billing.whatsapp_call_reap_holds';

export const CALLING_SETTINGS_SYNC_REASONS = ['connect', 'daily', 'manual', 'webhook'] as const;
export type CallingSettingsSyncReason = (typeof CALLING_SETTINGS_SYNC_REASONS)[number];

/** UTC crons. */
export const CALLING_SCHEDULES = [
  { name: CALLING_JOBS.permissionSweep, pattern: '7 * * * *' },
  // 04:20 IST
  { name: CALLING_JOBS.settingsSync, pattern: '50 22 * * *' },
] as const;
export const WHATSAPP_CALL_REAP_CRON = '*/30 * * * *';

/** One settings sync per number at a time (same id twice → one job). */
export const callingSettingsSyncJobId = (channelId: string): string =>
  `calling-settings-sync-${channelId}`;
export const CALLS_BACKFILL_IGNORE_JOB_ID = 'calls-backfill-ignore';
export const CALLING_DAILY_SYNC_JOB_ID = 'calling-settings-daily-sync';
export const PERMISSION_SWEEP_JOB_ID = 'call-permission-sweep';

export const CALLING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 86_400 },
} as const;

export interface CallingSettingsSyncJobData {
  /** One number; omitted = every number (the daily run). */
  channelId?: string;
  reason: CallingSettingsSyncReason;
}

/** Enqueues calling jobs (the API / webhooks depend on this, not on BullMQ). */
export interface CallingJobs {
  enqueueSettingsSync(channelId: string, reason: CallingSettingsSyncReason): Promise<void>;
}

export const queueCallingJobs = (queue: {
  add(name: string, data: unknown, opts: Record<string, unknown>): Promise<unknown>;
}): CallingJobs => ({
  async enqueueSettingsSync(channelId, reason) {
    await queue.add(
      CALLING_JOBS.settingsSync,
      { channelId, reason } satisfies CallingSettingsSyncJobData,
      { ...CALLING_JOB_OPTIONS, jobId: callingSettingsSyncJobId(channelId) },
    );
  },
});
