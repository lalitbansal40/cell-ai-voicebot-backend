import { describe, expect, it } from 'vitest';

import { TEMPLATE_LIMITS, WHATSAPP_BILLING_LIMITS } from '../../src/config/limits';
import { BILLING_JOB_NAMES, BILLING_SCHEDULES } from '../../src/core/billing/jobs';
import { WS_EVENT_TYPES } from '../../src/core/realtime/events';
import {
  DEFAULT_ACCOUNT_WHATSAPP_BILLING,
  DEFAULT_TEMPLATE_SETTINGS,
  WHATSAPP_PRICE_CATEGORIES,
} from '../../src/db/models/account.model';
import { MARKETING_STOP_SOURCES } from '../../src/db/models/contact.model';
import {
  LEDGER_REF_TYPES,
  LEDGER_TYPES,
  LEDGER_USAGE_KINDS,
} from '../../src/db/models/ledger-entry.model';
import {
  MESSAGE_BILLING_STATUSES,
  MESSAGE_ORIGINS,
  MESSAGE_PAYERS,
  MESSAGE_TYPES,
} from '../../src/db/models/message.model';
import { NOTIFICATION_TYPES } from '../../src/db/models/notification.model';
import { DEFAULT_WHATSAPP_BILLING_SETTINGS } from '../../src/db/models/platform-settings.model';
import { PLACEHOLDER_MARKETS } from '../../src/db/models/whatsapp-rate-card.model';
import {
  LIVE_TEMPLATE_STATUSES,
  PARAMETER_FORMATS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_PURPOSES,
  TEMPLATE_QUALITY,
  TEMPLATE_STATUSES,
  VARIABLE_SOURCES,
} from '../../src/db/models/whatsapp-template.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { PERMISSIONS } from '../../src/modules/rbac/permissions';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import {
  TEMPLATE_DAILY_SYNC_CRON,
  TEMPLATE_DAILY_SYNC_JOB,
  TEMPLATE_JOBS,
  TEMPLATE_SYNC_JOB_OPTIONS,
  TEMPLATE_SYNC_REASONS,
  TEMPLATES_BACKFILL_JOB_ID,
  templateSyncJobId,
} from '../../src/modules/templates/jobs';
import {
  TEMPLATE_EMAIL_SUBJECTS,
  TEMPLATE_NOTIFICATIONS,
} from '../../src/modules/templates/notification-types';
import { AppError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';

describe('Phase 11 catalogue', () => {
  it('has the ten template / frequency error codes (count: Phase 12 catalogue test)', () => {
    const added = [
      'TEMPLATE_NOT_FOUND',
      'TEMPLATE_NOT_APPROVED',
      'TEMPLATE_PAUSED',
      'TEMPLATE_VARIABLES_MISSING',
      'TEMPLATE_PARAMS_INVALID',
      'TEMPLATE_EDIT_NOT_ALLOWED',
      'TEMPLATE_NAME_TAKEN',
      'TEMPLATE_LIMIT_REACHED',
      'TEMPLATE_MARKETING_BLOCKED',
      'WHATSAPP_FREQUENCY_LIMIT',
    ] as const;
    expect(added.map((k) => ERROR_CODES[k].status)).toEqual([
      404, 409, 409, 422, 422, 409, 409, 409, 409, 429,
    ]);
    // the wallet codes are reused, not duplicated
    expect(ERROR_CODES.WALLET_INSUFFICIENT_BALANCE.status).toBe(422);
    expect(ERROR_CODES.WALLET_BUDGET_EXCEEDED.status).toBe(422);
    expect(new AppError('TEMPLATE_NAME_TAKEN').message).toContain('deleted recently');
  });

  it('has the twelve Phase 11 audit actions (count: Phase 12 catalogue test)', () => {
    expect(AUDIT_ACTIONS.slice(-21, -9)).toEqual([
      'template.created',
      'template.submitted',
      'template.updated',
      'template.deleted',
      'template.synced',
      'template.status_changed',
      'template.category_changed',
      'template.variables_updated',
      'whatsapp.rate_card_saved',
      'whatsapp.billing_settings_updated',
      'account.whatsapp_billing_updated',
      'contact.whatsapp_marketing_changed',
    ]);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('has the 7 Phase 11 notification types with titles, audiences, links and e-mail flags', () => {
    // count: Phase 12 catalogue test
    const added = NOTIFICATION_TYPES.slice(19, 26);
    expect(added).toEqual([
      'template.approved',
      'template.rejected',
      'template.paused',
      'template.disabled',
      'template.category_changed',
      'template.quality_low',
      'wallet.whatsapp_late_charge',
    ]);
    expect(Object.keys(TEMPLATE_NOTIFICATIONS)).toEqual(added);
    expect(
      Object.entries(TEMPLATE_NOTIFICATIONS)
        .filter(([, v]) => v.email)
        .map(([k]) => k),
    ).toEqual(['template.rejected', 'template.disabled']);
    expect(Object.keys(TEMPLATE_EMAIL_SUBJECTS)).toEqual([
      'template.rejected',
      'template.disabled',
    ]);
    expect(TEMPLATE_NOTIFICATIONS['template.approved'].title).toBe('Template approved');
    expect(TEMPLATE_NOTIFICATIONS['template.approved'].link('abc')).toBe(
      '/whatsapp/templates?id=abc',
    );
    expect(TEMPLATE_NOTIFICATIONS['template.rejected'].link()).toBe('/whatsapp/templates');
    expect(TEMPLATE_NOTIFICATIONS['wallet.whatsapp_late_charge']).toMatchObject({
      audience: 'billing_admins',
    });
    expect(TEMPLATE_NOTIFICATIONS['wallet.whatsapp_late_charge'].link()).toBe('/wallet');
    for (const spec of Object.values(TEMPLATE_NOTIFICATIONS)) {
      expect(spec.title.length).toBeLessThanOrEqual(120);
    }
  });

  it('has the template WS event', () => {
    expect(WS_EVENT_TYPES).toContain('whatsapp.template.updated');
    expect(new Set(WS_EVENT_TYPES).size).toBe(WS_EVENT_TYPES.length);
  });

  it('template permissions per role', () => {
    expect(PERMISSIONS).toEqual(expect.arrayContaining(['templates.read', 'templates.manage']));
    const roles = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;
    const has = (p: string) =>
      roles.map((r) => (SYSTEM_ROLES[r].permissions as string[]).includes(p));
    expect(has('templates.read')).toEqual([true, true, true, true, true]);
    expect(has('templates.manage')).toEqual([true, true, true, false, false]);
  });

  it('job names, ids (no `:`) and schedules', () => {
    expect(TEMPLATE_JOBS).toEqual({ sync: 'template.sync', backfill: 'templates.backfill' });
    expect(TEMPLATE_SYNC_REASONS).toEqual(['connect', 'daily', 'manual', 'webhook']);
    expect(templateSyncJobId('c1')).toBe('template-sync-c1');
    expect(TEMPLATES_BACKFILL_JOB_ID).toBe('templates-backfill');
    for (const id of [
      templateSyncJobId('c1'),
      TEMPLATES_BACKFILL_JOB_ID,
      TEMPLATE_DAILY_SYNC_JOB,
    ]) {
      expect(id).not.toContain(':');
    }
    expect(TEMPLATE_SYNC_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(TEMPLATE_DAILY_SYNC_CRON).toBe('40 22 * * *');
    expect(BILLING_JOB_NAMES).toEqual(
      expect.arrayContaining(['billing.whatsapp_reap_holds', 'billing.whatsapp_reconcile']),
    );
    expect(BILLING_SCHEDULES).toEqual(
      expect.arrayContaining([
        { name: 'billing.whatsapp_reap_holds', pattern: '*/30 * * * *' },
        { name: 'billing.whatsapp_reconcile', pattern: '30 21 * * *' },
      ]),
    );
  });

  it('model constants', () => {
    expect(TEMPLATE_CATEGORIES).toEqual(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
    expect(TEMPLATE_STATUSES).toHaveLength(12);
    expect(LIVE_TEMPLATE_STATUSES).not.toContain('DELETED');
    expect(LIVE_TEMPLATE_STATUSES).toHaveLength(11);
    expect(TEMPLATE_QUALITY).toEqual(['GREEN', 'YELLOW', 'RED', 'UNKNOWN']);
    expect(PARAMETER_FORMATS).toEqual(['positional', 'named']);
    expect(TEMPLATE_PURPOSES).toEqual(['general', 'call_permission']);
    expect(VARIABLE_SOURCES).toEqual([
      'contact.name',
      'contact.phone',
      'contact.email',
      'field',
      'static',
      'ask',
    ]);
    // `call` arrives in Phase 12 (count: Phase 12 catalogue test)
    expect(MESSAGE_TYPES).toContain('template');
    expect(MESSAGE_ORIGINS).toEqual([
      'customer',
      'agent',
      'business_app',
      'history',
      'system',
      'api',
    ]);
    expect(MESSAGE_BILLING_STATUSES).toEqual([
      'none',
      'held',
      'captured',
      'released',
      'late_charged',
      'waived',
    ]);
    expect(MESSAGE_PAYERS).toEqual(['platform', 'customer']);
    expect(LEDGER_TYPES).toContain('whatsapp_charge');
    expect(LEDGER_REF_TYPES).toContain('whatsapp_message');
    expect(LEDGER_USAGE_KINDS).toContain('whatsapp');
    expect(MARKETING_STOP_SOURCES).toEqual(['user_preferences', 'error_131050', 'manual']);
    expect(WHATSAPP_PRICE_CATEGORIES).toEqual([
      'marketing',
      'utility',
      'authentication',
      'service',
    ]);
  });

  it('owner defaults (23 Oct 2026)', () => {
    expect(DEFAULT_TEMPLATE_SETTINGS).toEqual({ defaultLanguage: 'en' });
    expect(DEFAULT_ACCOUNT_WHATSAPP_BILLING).toEqual({
      markupBps: null,
      fixedPrices: null,
      platformFeeMicros: null,
    });
    expect(DEFAULT_WHATSAPP_BILLING_SETTINGS).toEqual({
      markupBps: 1500,
      platformFeeMicros: 0,
      holdMaxAgeHours: 72,
    });
    expect(PLACEHOLDER_MARKETS.map((m) => m.market)).toEqual(['IN', 'OTHER']);
    for (const m of PLACEHOLDER_MARKETS) {
      expect(m).toMatchObject({
        marketingMicros: 863_100,
        utilityMicros: 115_000,
        authenticationMicros: 115_000,
        serviceMicros: 115_000,
      });
    }
    expect(PLACEHOLDER_MARKETS[0]?.callingCodes).toEqual(['91']);
  });

  it('limits (exact)', () => {
    expect(TEMPLATE_LIMITS).toEqual({
      nameMax: 512,
      namePattern: /^[a-z0-9_]+$/,
      headerTextMax: 60,
      headerVariablesMax: 1,
      bodyMax: 1024,
      footerMax: 60,
      buttonsMax: 10,
      quickRepliesMax: 10,
      urlButtonsMax: 2,
      phoneButtonsMax: 1,
      copyCodeButtonsMax: 1,
      voiceCallButtonsMax: 1,
      buttonTextMax: 25,
      urlMax: 2000,
      phoneMax: 20,
      copyCodeExampleMax: 20,
      variablesMax: 20,
      variableValueMax: 1024,
      templatesPerWabaUnverified: 250,
      templatesPerWabaVerified: 6000,
      createsPerHourPerWaba: 100,
      createsPerHourPerUser: 20,
      approvedEditsPer30Days: 10,
      approvedEditGapMs: 24 * 3600_000,
      deletedNameLockMs: 30 * 24 * 3600_000,
      syncPageSize: 100,
      syncPerMinutePerWaba: 1,
      statusHistoryMax: 30,
      marketingPerContactWindowMs: 24 * 3600_000,
      headerExampleMaxBytes: {
        image: 5 * 1024 * 1024,
        video: 16 * 1024 * 1024,
        document: 100 * 1024 * 1024,
      },
    });
    expect(WHATSAPP_BILLING_LIMITS).toEqual({
      defaultMarkupBps: 1500,
      holdMaxAgeMs: 72 * 3600_000,
      reapBatch: 1000,
      reconcileDays: 3,
      freeServiceTierPerNumber: 1000,
      rateCardMarketsMax: 300,
      csvMaxBytes: 2 * 1024 * 1024,
    });
    expect(TEMPLATE_LIMITS.namePattern.test('order_update_2')).toBe(true);
    expect(TEMPLATE_LIMITS.namePattern.test('Order-Update')).toBe(false);
  });
});
