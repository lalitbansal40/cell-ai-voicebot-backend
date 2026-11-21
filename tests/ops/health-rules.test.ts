import { describe, expect, it } from 'vitest';

import { parseFailedBefore } from '../../src/ops/health-check';
import { failedTotal, healthIssues, HEALTH_LIMITS } from '../../src/ops/health-rules';

const now = new Date('2026-11-02T12:00:00Z');
const facts = (over: Partial<Parameters<typeof healthIssues>[0]> = {}) => ({
  mongoPrimary: true,
  queues: { whatsapp: { waiting: 0, failed: 0 }, webhooks: { waiting: 0, failed: 0 } },
  failedBefore: 0,
  lastBackupAt: '2026-11-02T02:00:00Z',
  now,
  ...over,
});

describe('healthwatch rules', () => {
  it('is quiet when all is well', () => {
    expect(healthIssues(facts())).toEqual([]);
  });

  it('flags a missing primary, a backlog, an unreadable queue, a rise in failures and an old backup', () => {
    expect(
      healthIssues(
        facts({
          mongoPrimary: false,
          queues: {
            whatsapp: { waiting: HEALTH_LIMITS.backlog + 1, failed: 30 },
            webhooks: { waiting: -1, failed: 30 },
          },
          failedBefore: 10,
          lastBackupAt: '2026-11-01T09:00:00Z',
        }),
      ),
    ).toEqual([
      'mongo-primary',
      'queue-backlog-whatsapp',
      'queue-unreadable-webhooks',
      'failed-jobs',
      'backup-age',
    ]);
  });

  it('needs a previous count before failures can rise, and treats no backup as old', () => {
    const many = { whatsapp: { waiting: 0, failed: 500 }, webhooks: { waiting: 0, failed: 0 } };
    expect(healthIssues(facts({ queues: many, failedBefore: null }))).toEqual([]);
    expect(healthIssues(facts({ queues: many, failedBefore: 451 }))).toEqual([]);
    expect(healthIssues(facts({ lastBackupAt: null }))).toEqual(['backup-age']);
    expect(failedTotal({ a: { waiting: 0, failed: -1 }, b: { waiting: 0, failed: 3 } })).toBe(3);
  });

  it('reads --failed-before', () => {
    expect(parseFailedBefore([])).toBeNull();
    expect(parseFailedBefore(['--failed-before', '12'])).toBe(12);
    expect(parseFailedBefore(['--failed-before', 'x'])).toBeNull();
  });

  it('SAC-T4: a number whose webhook check failed raises wa-webhook-missing', () => {
    const wa = { mediaEnabled: true, publicIpSet: true, failedSetups15m: 0 };
    expect(healthIssues(facts({ whatsappCalls: { ...wa, webhookMissing: 1 } }))).toContain(
      'wa-webhook-missing',
    );
    expect(healthIssues(facts({ whatsappCalls: { ...wa, webhookMissing: 0 } }))).not.toContain(
      'wa-webhook-missing',
    );
  });

  it('SAC-T12: slow first AI words (p95 > 2.5 s) raise wa-ai-latency-high', () => {
    const wa = { mediaEnabled: true, publicIpSet: true, failedSetups15m: 0 };
    expect(healthIssues(facts({ whatsappCalls: { ...wa, aiFirstAudioP95Ms: 3_100 } }))).toContain(
      'wa-ai-latency-high',
    );
    expect(healthIssues(facts({ whatsappCalls: { ...wa, aiFirstAudioP95Ms: 900 } }))).not.toContain(
      'wa-ai-latency-high',
    );
    expect(
      healthIssues(facts({ whatsappCalls: { ...wa, aiFirstAudioP95Ms: null } })),
    ).not.toContain('wa-ai-latency-high');
  });
});
