/** Alert rules healthwatch adds on top of its host checks (Phase 17, run prompt §1). */
export interface HealthFacts {
  mongoPrimary: boolean;
  queues: Record<string, { waiting: number; failed: number }>;
  /** Failed jobs over all queues at the previous run, or null on the first run. */
  failedBefore: number | null;
  lastBackupAt: string | null;
  now: Date;
  /** Phase 18: the SIP line (absent / null = no trunk on this install). */
  sip?: { ariConnected: boolean; trunkOnline: boolean | null; avgLossPct: number | null } | null;
  /** Phase 18B: WhatsApp call audio (absent / null = WhatsApp off). */
  whatsappCalls?: {
    mediaEnabled: boolean;
    publicIpSet: boolean;
    failedSetups15m: number;
    /** SAC-T4: Meta numbers whose webhook check failed (absent on older APIs). */
    webhookMissing?: number;
    /** SAC-T12: p95 answer → first audio of AI calls, 30 min (null = too few calls). */
    aiFirstAudioP95Ms?: number | null;
    /** PMC: managed numbers whose Meta calling broke (absent on older APIs). */
    metaCallingBroken?: number;
    metaCallErrors1h?: number;
  } | null;
  /** `production` turns on the public IP rule. */
  env?: string;
}

export const HEALTH_LIMITS = {
  /** Waiting jobs on a queue Meta's webhooks or customers' sends go through. */
  backlog: 1_000,
  backlogQueues: ['whatsapp', 'webhooks'],
  /** New failed jobs since the previous run (healthwatch runs every 5 minutes). */
  failedRise: 50,
  backupMaxAgeMs: 26 * 3_600_000,
  /** Average RTP loss of the last 24 h of SIP calls above this → alert. */
  sipLossPct: 5,
  /** Failed WhatsApp call setups in 15 minutes at or above this → alert. */
  waCallSetupFailures: 3,
  /** SAC-T12: p95 answer → first AI audio above this → alert. */
  waAiFirstAudioMs: 2_500,
  /** Meta Graph calling failures in the last hour. */
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
  if (f.sip) {
    if (!f.sip.ariConnected) issues.push('sip-ari-down');
    else if (f.sip.trunkOnline === false) issues.push('sip-trunk-offline');
    if (f.sip.avgLossPct !== null && f.sip.avgLossPct > HEALTH_LIMITS.sipLossPct) {
      issues.push('sip-audio-loss');
    }
  }
  if (f.whatsappCalls) {
    if (f.env === 'production' && f.whatsappCalls.mediaEnabled && !f.whatsappCalls.publicIpSet) {
      issues.push('wa-media-no-public-ip');
    }
    if (f.whatsappCalls.failedSetups15m >= HEALTH_LIMITS.waCallSetupFailures) {
      issues.push('wa-call-setup-failing');
    }
    if ((f.whatsappCalls.webhookMissing ?? 0) > 0) issues.push('wa-webhook-missing');
    if ((f.whatsappCalls.metaCallingBroken ?? 0) > 0) issues.push('wa-meta-calling-broken');
    if ((f.whatsappCalls.metaCallErrors1h ?? 0) >= META_CALL_DIAG.healthErrorsPerHour)
      issues.push('wa-meta-call-errors');
    const p95 = f.whatsappCalls.aiFirstAudioP95Ms ?? null;
    if (p95 !== null && p95 > HEALTH_LIMITS.waAiFirstAudioMs) issues.push('wa-ai-latency-high');
  }
  return issues;
};
import { META_CALL_DIAG } from '../config/limits';
