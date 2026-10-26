import { describe, expect, it } from 'vitest';

import { WHATSAPP_CALL_LIMITS } from '../../src/config/limits';
import { WS_EVENT_TYPES } from '../../src/core/realtime/events';
import {
  DEFAULT_ACCOUNT_WHATSAPP_CALLING_BILLING,
  DEFAULT_WHATSAPP_CALLING_SETTINGS,
} from '../../src/db/models/account.model';
import {
  CALL_END_REASONS,
  CALL_MODES,
  CALL_PROVIDERS,
  WA_CALL_BILLING_STATUSES,
  WA_CALL_DIRECTIONS,
} from '../../src/db/models/call.model';
import {
  LEDGER_REF_TYPES,
  LEDGER_TYPES,
  LEDGER_USAGE_KINDS,
} from '../../src/db/models/ledger-entry.model';
import {
  CALL_MESSAGE_OUTCOMES,
  CALL_PERMISSION_RESPONSES,
  INTERACTIVE_KINDS,
  MESSAGE_TYPES,
} from '../../src/db/models/message.model';
import { NOTIFICATION_TYPES } from '../../src/db/models/notification.model';
import {
  DEFAULT_WHATSAPP_CALLING_SETTINGS as DEFAULT_PLATFORM_CALLING,
  PLATFORM_SETTING_KEYS,
} from '../../src/db/models/platform-settings.model';
import { CALL_AVAILABILITY } from '../../src/db/models/user.model';
import {
  CALL_PERMISSION_SOURCES,
  CALL_PERMISSION_STATUSES,
  CALLABLE_PERMISSION_STATUSES,
} from '../../src/db/models/whatsapp-call-permission.model';
import {
  DEFAULT_PERMISSION_REQUEST_BODY,
  INBOUND_ROUTES,
  WA_CALLING_STATUSES,
  WA_CALLING_UNAVAILABLE_REASONS,
  WEEK_DAYS,
} from '../../src/db/models/whatsapp-channel.model';
import { RATE_CARD_KINDS } from '../../src/db/models/whatsapp-rate-card.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { PERMISSIONS } from '../../src/modules/rbac/permissions';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import {
  CALLING_DAILY_SYNC_JOB_ID,
  CALLING_JOB_OPTIONS,
  CALLING_JOBS,
  CALLING_SCHEDULES,
  CALLING_SETTINGS_SYNC_REASONS,
  CALLS_BACKFILL_IGNORE_JOB_ID,
  callingSettingsSyncJobId,
  PERMISSION_SWEEP_JOB_ID,
  WHATSAPP_CALL_REAP_CRON,
  WHATSAPP_CALL_REAP_JOB,
} from '../../src/modules/whatsapp-calling/jobs';
import {
  CALLING_EMAIL_SUBJECTS,
  CALLING_NOTIFICATIONS,
} from '../../src/modules/whatsapp-calling/notification-types';
import { AppError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';

describe('Phase 12 catalogue', () => {
  it('has 83 error codes incl. the fourteen calling codes (exact texts and statuses)', () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(86); // + Phase 14 T14.3: 3
    const added = {
      WHATSAPP_CALLING_DISABLED: [409, 'Calling is turned off for this WhatsApp number.'],
      WHATSAPP_CALLING_UNAVAILABLE: [409, "WhatsApp calling isn't available for this number."],
      WHATSAPP_CALLING_RESTRICTED: [409, 'WhatsApp has paused calling on this number for now.'],
      WHATSAPP_CALL_PERMISSION_MISSING: [
        409,
        "This customer hasn't allowed calls from this number yet.",
      ],
      WHATSAPP_CALL_PERMISSION_CHECK_FAILED: [
        502,
        "Couldn't check the customer's call permission with WhatsApp. Try again.",
      ],
      WHATSAPP_CALL_PERMISSION_LIMIT: [
        429,
        'You can ask this customer for call permission again later.',
      ],
      WHATSAPP_CALL_PERMISSION_EXISTS: [409, 'This customer already allows calls.'],
      WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING: [
        409,
        'Create and get the call permission template approved first.',
      ],
      WHATSAPP_CALL_LIMIT_REACHED: [
        429,
        "WhatsApp's call limit for this customer is reached. Try again later.",
      ],
      WHATSAPP_CALL_ACTIVE: [409, 'A call with this customer is already in progress.'],
      WHATSAPP_CALL_TAKEN: [409, 'Someone else already answered this call.'],
      WHATSAPP_CALL_NOT_RINGING: [409, "This call isn't ringing any more."],
      WHATSAPP_CALL_FAILED: [502, "WhatsApp couldn't connect the call."],
      CALL_AGENT_UNAVAILABLE: [409, 'No team member is available to take the call.'],
    } as const;
    expect(Object.keys(ERROR_CODES).slice(69, 83)).toEqual(Object.keys(added));
    for (const [code, [status, message]] of Object.entries(added)) {
      expect(ERROR_CODES[code as keyof typeof added]).toEqual({ status, message });
    }
    expect(new AppError('WHATSAPP_CALL_TAKEN').message).toBe(
      'Someone else already answered this call.',
    );
  });

  it('has 127 audit actions incl. the nine Phase 12 actions', () => {
    expect(AUDIT_ACTIONS).toHaveLength(131); // + Phase 14 T14.3: 4
    expect(AUDIT_ACTIONS.slice(118, 127)).toEqual([
      'whatsapp.calling_settings_updated',
      'whatsapp.call_permission_requested',
      'whatsapp.call_permission_granted',
      'whatsapp.call_permission_declined',
      'whatsapp.call_permission_revoked',
      'call.whatsapp_started',
      'call.whatsapp_answered',
      'call.whatsapp_transferred',
      'whatsapp.calling_restricted',
    ]);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('adds 5 notification types (26 + 5; Phase 14: 32) with titles, audiences, links and e-mail flags', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(32); // + Phase 14 analytics.reconcile_mismatch
    const added = NOTIFICATION_TYPES.slice(26, 31);
    expect(added).toEqual([
      'call.whatsapp_missed',
      'whatsapp.call_permission_granted',
      'whatsapp.call_permission_declined',
      'whatsapp.calling_restricted',
      'whatsapp.call_permission_revoked',
    ]);
    expect(Object.keys(CALLING_NOTIFICATIONS)).toEqual(added);
    expect(
      Object.entries(CALLING_NOTIFICATIONS)
        .filter(([, v]) => v.email)
        .map(([k]) => k),
    ).toEqual(['whatsapp.calling_restricted']);
    expect(Object.keys(CALLING_EMAIL_SUBJECTS)).toEqual(['whatsapp.calling_restricted']);
    expect(
      Object.fromEntries(Object.entries(CALLING_NOTIFICATIONS).map(([k, v]) => [k, v.audience])),
    ).toEqual({
      'call.whatsapp_missed': 'ring_list',
      'whatsapp.call_permission_granted': 'requester',
      'whatsapp.call_permission_declined': 'requester',
      'whatsapp.calling_restricted': 'owners_admins',
      'whatsapp.call_permission_revoked': 'requester_and_managers',
    });
    expect(CALLING_NOTIFICATIONS['call.whatsapp_missed'].link('c1')).toBe('/inbox/c1');
    expect(CALLING_NOTIFICATIONS['call.whatsapp_missed'].link()).toBe('/inbox');
    expect(CALLING_NOTIFICATIONS['whatsapp.calling_restricted'].link()).toBe('/whatsapp/numbers');
    for (const spec of Object.values(CALLING_NOTIFICATIONS)) {
      expect(spec.title.length).toBeLessThanOrEqual(120);
      // no customer data in titles
      expect(spec.title).not.toMatch(/\d{5}|\{/);
    }
  });

  it('has the four calling WS events', () => {
    expect(WS_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'whatsapp.call.incoming',
        'whatsapp.call.taken',
        'whatsapp.call.ended_ringing',
        'whatsapp.call_permission.updated',
      ]),
    );
    expect(new Set(WS_EVENT_TYPES).size).toBe(WS_EVENT_TYPES.length);
  });

  it('calling permissions per role', () => {
    expect(PERMISSIONS).toEqual(
      expect.arrayContaining(['calls.answer', 'whatsapp.calling.manage']),
    );
    const roles = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;
    const has = (p: string) =>
      roles.map((r) => (SYSTEM_ROLES[r].permissions as string[]).includes(p));
    expect(has('calls.answer')).toEqual([true, true, true, true, false]);
    expect(has('whatsapp.calling.manage')).toEqual([true, true, false, false, false]);
    expect(has('calls.trigger')).toEqual([true, true, true, true, false]);
  });

  it('job names, ids (no `:`) and schedules', () => {
    expect(CALLING_JOBS).toEqual({
      permissionSweep: 'whatsapp.call_permission_sweep',
      settingsSync: 'whatsapp.calling_settings_sync',
      backfillIgnore: 'whatsapp.calls_backfill_ignore',
    });
    expect(WHATSAPP_CALL_REAP_JOB).toBe('billing.whatsapp_call_reap_holds');
    expect(CALLING_SCHEDULES).toEqual([
      { name: 'whatsapp.call_permission_sweep', pattern: '7 * * * *' },
      { name: 'whatsapp.calling_settings_sync', pattern: '50 22 * * *' },
    ]);
    expect(WHATSAPP_CALL_REAP_CRON).toBe('*/30 * * * *');
    expect(CALLING_SETTINGS_SYNC_REASONS).toEqual(['connect', 'daily', 'manual', 'webhook']);
    expect(callingSettingsSyncJobId('c1')).toBe('calling-settings-sync-c1');
    for (const id of [
      callingSettingsSyncJobId('c1'),
      CALLS_BACKFILL_IGNORE_JOB_ID,
      CALLING_DAILY_SYNC_JOB_ID,
      PERMISSION_SWEEP_JOB_ID,
    ]) {
      expect(id).not.toContain(':');
    }
    expect(CALLING_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });

  it('model constants', () => {
    expect(MESSAGE_TYPES).toHaveLength(17);
    expect(MESSAGE_TYPES.at(-1)).toBe('call');
    expect(INTERACTIVE_KINDS.slice(-3)).toEqual([
      'call_permission_request',
      'call_permission_reply',
      'voice_call',
    ]);
    expect(CALL_MESSAGE_OUTCOMES).toEqual([
      'missed',
      'completed',
      'rejected',
      'failed',
      'no_answer',
    ]);
    expect(CALL_PERMISSION_RESPONSES).toEqual(['accept', 'reject']);
    expect(CALL_PROVIDERS).toContain('whatsapp');
    expect(CALL_MODES).toEqual(['ai', 'human']);
    expect(WA_CALL_DIRECTIONS).toEqual(['BUSINESS_INITIATED', 'USER_INITIATED']);
    expect(WA_CALL_BILLING_STATUSES).toEqual(['free', 'held', 'settled', 'released']);
    expect(CALL_END_REASONS.slice(-7)).toEqual([
      'rejected_by_customer',
      'not_answered',
      'meta_failed',
      'permission_missing',
      'calling_restricted',
      'no_agent_available',
      'outside_call_hours',
    ]);
    expect(LEDGER_TYPES).toContain('whatsapp_call_charge');
    expect(LEDGER_REF_TYPES).toContain('call');
    expect(LEDGER_USAGE_KINDS).toContain('whatsapp_call');
    expect(CALL_PERMISSION_STATUSES).toEqual([
      'none',
      'requested',
      'temporary',
      'permanent',
      'declined',
      'expired',
      'revoked',
    ]);
    expect(CALLABLE_PERMISSION_STATUSES).toEqual(['temporary', 'permanent']);
    expect(CALL_PERMISSION_SOURCES).toEqual(['request_reply', 'callback', 'profile', 'unknown']);
    expect(WA_CALLING_STATUSES).toEqual(['disabled', 'enabled', 'unavailable']);
    expect(WA_CALLING_UNAVAILABLE_REASONS).toEqual([
      'coexistence',
      'country',
      'messaging_limit',
      'not_cloud_api',
    ]);
    expect(INBOUND_ROUTES).toEqual(['team', 'ai', 'ai_then_team']);
    expect(WEEK_DAYS).toHaveLength(7);
    expect(CALL_AVAILABILITY).toEqual(['available', 'busy', 'offline']);
    expect(RATE_CARD_KINDS).toEqual(['messaging', 'calling']);
    expect(PLATFORM_SETTING_KEYS).toEqual(['whatsappBilling', 'whatsappCalling']);
  });

  it('owner defaults (plan §7, defaults in use)', () => {
    expect(DEFAULT_WHATSAPP_CALLING_SETTINGS).toMatchObject({
      recordCalls: true,
      transcribeHumanCalls: false,
      maxCallMinutes: 30,
    });
    expect(DEFAULT_WHATSAPP_CALLING_SETTINGS.recordingNotice.length).toBeGreaterThan(0);
    expect(DEFAULT_ACCOUNT_WHATSAPP_CALLING_BILLING).toEqual({
      markupBps: null,
      fixedPerMinuteMicros: null,
      platformFeePerMinuteMicros: null,
    });
    expect(DEFAULT_PLATFORM_CALLING).toEqual({
      markupBps: 1500,
      platformFeePerMinuteMicros: 0,
      holdMinutes: 5,
      holdExtendMinutes: 5,
    });
    expect(DEFAULT_PERMISSION_REQUEST_BODY).toBe(
      'Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai.',
    );
  });

  it('limits (exact)', () => {
    expect(WHATSAPP_CALL_LIMITS).toEqual({
      permissionRequestsPerDay: 1,
      permissionRequestsPerWeek: 2,
      temporaryPermissionDays: 7,
      connectedCallsPer24h: 100,
      unansweredNudge: 2,
      unansweredRevoke: 4,
      concurrentPerNumber: 1_000,
      initiationsPer24hPerNumber: 10_000,
      permissionCacheSec: 60,
      bicRingTimeoutSec: 45,
      uicRingTimeoutSec: 30,
      uicAnswerDeadlineSec: 30,
      firstMediaWithinMs: 1_000,
      keepAliveEveryMs: 20,
      rtcpEverySec: 5,
      jitterBufferMs: 60,
      ownerTtlSec: 30,
      claimTtlSec: 120,
      pulseSec: 6,
      holdMinutes: 5,
      holdExtendMinutes: 5,
      lateTerminateGraceSec: 120,
      maxCallMinutesDefault: 30,
      requestBodyMax: 1_024,
      voiceCallButtonTextMax: 20,
      voiceCallTtlMinutesMax: 43_200,
      callHoursEntriesPerDayMax: 2,
      holidaysMax: 20,
      ringTargetsMax: 50,
      sdpMaxBytes: 16_384,
    });
  });
});
