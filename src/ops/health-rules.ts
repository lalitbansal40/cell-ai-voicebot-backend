/** Alert rules healthwatch adds on top of its host checks (Phase 17, run prompt §1). */
export interface HealthFacts {
  mongoPrimary: boolean;
  queues: Record<string, { waiting: number; failed: number }>;
  /** Failed jobs over all queues at the previous run, or null on the first run. */
  failedBefore: number | null;
  lastBackupAt: string | null;
  now: Date;
}

export const HEALTH_LIMITS = {
  /** Waiting jobs on a queue Meta's webhooks or customers' sends go through. */
  backlog: 1_000,
  backlogQueues: ['whatsapp', 'webhooks'],
  /** New failed jobs since the previous run (healthwatch runs every 5 minutes). */
  failedRise: 50,
  backupMaxAgeMs: 26 * 3_600_000,
} as const;

export const failedTotal = (queues: HealthFacts['queues']): number =>
  Object.values(queues).reduce((sum, q) => sum + Math.max(0, q.failed), 0);

/** Alert keys, in a fixed order; healthwatch mails each at most hourly. */
export const healthIssues = (f: HealthFacts): string[] => {
  const issues: string[] = [];
  if (!f.mongoPrimary) issues.push('mongo-primary');
  for (const name of HEALTH_LIMITS.backlogQueues) {
    const waiting = f.queues[name]?.waiting ?? 0;
    if (waiting < 0) issues.push(`queue-unreadable-${name}`);
    else if (waiting > HEALTH_LIMITS.backlog) issues.push(`queue-backlog-${name}`);
  }
  if (
    f.failedBefore !== null &&
    failedTotal(f.queues) - f.failedBefore >= HEALTH_LIMITS.failedRise
  ) {
    issues.push('failed-jobs');
  }
  const backup = f.lastBackupAt ? Date.parse(f.lastBackupAt) : NaN;
  if (Number.isNaN(backup) || f.now.getTime() - backup > HEALTH_LIMITS.backupMaxAgeMs) {
    issues.push('backup-age');
  }
  return issues;
};
