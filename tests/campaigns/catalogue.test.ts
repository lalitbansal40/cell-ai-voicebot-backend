import { describe, expect, it } from 'vitest';

import { CAMPAIGN_LIMITS } from '../../src/config/limits';
import { WS_EVENT_TYPES } from '../../src/core/realtime/events';
import {
  DEFAULT_ACCOUNT_LIMITS,
  DEFAULT_ACCOUNT_SETTINGS,
} from '../../src/db/models/account.model';
import { CALL_PROVIDERS, CALL_END_REASONS } from '../../src/db/models/call.model';
import {
  defaultDryRun,
  DRY_RUN_OUTCOMES,
  emptyCampaignStats,
  SCENARIO_KEYS,
  SKIP_REASONS,
} from '../../src/db/models/campaign.model';
import { NOTIFICATION_TYPES } from '../../src/db/models/notification.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { PERMISSIONS } from '../../src/modules/rbac/permissions';
import { AppError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';

describe('Phase 8 catalogue', () => {
  it('has the three campaign error codes (count: Phase 9 catalogue test)', () => {
    expect(Object.keys(ERROR_CODES)).toEqual(
      expect.arrayContaining([
        'CALL_NOT_ALLOWED',
        'CAMPAIGN_LIMIT_REACHED',
        'CAMPAIGN_REVISION_CONFLICT',
      ]),
    );
    expect(new AppError('CALL_NOT_ALLOWED')).toMatchObject({
      status: 422,
      message: "This contact can't be called right now.",
    });
    expect(ERROR_CODES.CAMPAIGN_LIMIT_REACHED.status).toBe(429);
    expect(ERROR_CODES.CAMPAIGN_REVISION_CONFLICT.status).toBe(409);
    expect(ERROR_CODES.CAMPAIGN_NOT_RUNNABLE.status).toBe(409);
    expect(ERROR_CODES.CALL_OUTSIDE_WINDOW.status).toBe(422);
  });

  it('has the campaign audit actions (count: Phase 9 catalogue test)', () => {
    expect(AUDIT_ACTIONS.filter((a) => a.startsWith('campaign.'))).toEqual([
      'campaign.created',
      'campaign.updated',
      'campaign.scheduled',
      'campaign.started',
      'campaign.paused',
      'campaign.resumed',
      'campaign.canceled',
      'campaign.deleted',
      'campaign.exported',
      'campaign.admin_paused',
    ]);
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(['call.triggered', 'account.limits_updated']),
    );
  });

  it('notification types, WS events, permission and providers', () => {
    expect(NOTIFICATION_TYPES).toEqual(
      expect.arrayContaining(['campaign.completed', 'campaign.paused', 'campaign.run_skipped']),
    );
    expect(WS_EVENT_TYPES).toEqual(
      expect.arrayContaining(['campaign.status', 'campaign.progress']),
    );
    expect(PERMISSIONS).toContain('campaigns.export');
    expect(CALL_PROVIDERS).toContain('dryrun');
    expect(CALL_END_REASONS).toEqual(
      expect.arrayContaining(['busy', 'no_answer', 'invalid_number', 'campaign_canceled']),
    );
  });

  it('defaults: dry-run mix sums to 10 000, every scenario weighted, zeroed counters', () => {
    const d = defaultDryRun();
    expect(Object.keys(d.mix)).toEqual([...DRY_RUN_OUTCOMES]);
    expect(Object.values(d.mix).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(Object.keys(d.scenarios)).toEqual([...SCENARIO_KEYS]);
    expect(Object.values(d.scenarios).reduce((a, b) => a + b, 0)).toBe(100);
    expect(CAMPAIGN_LIMITS.dryRunSpeeds).toContain(d.speed);
    const stats = emptyCampaignStats();
    expect(Object.keys(stats.skippedBy)).toEqual([...SKIP_REASONS]);
    expect(Object.values(stats.dispositions).every((n) => n === 0)).toBe(true);
    expect(DEFAULT_ACCOUNT_LIMITS).toEqual({ maxConcurrentCalls: 10, dialsPerMinute: 60 });
    expect(DEFAULT_ACCOUNT_SETTINGS.callCaps).toEqual({
      perDay: 3,
      perWeek: 10,
      minGapMinutes: 30,
    });
    expect(CAMPAIGN_LIMITS.defaults.concurrency).toBeLessThanOrEqual(
      DEFAULT_ACCOUNT_LIMITS.maxConcurrentCalls,
    );
    expect(CAMPAIGN_LIMITS.defaults.dialsPerMinute).toBeLessThanOrEqual(
      DEFAULT_ACCOUNT_LIMITS.dialsPerMinute,
    );
  });
});
