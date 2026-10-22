import { describe, expect, it } from 'vitest';

import { WHATSAPP_LIMITS } from '../../src/config/limits';
import { QUEUES } from '../../src/core/queues/names';
import { WS_EVENT_TYPES } from '../../src/core/realtime/events';
import { DEFAULT_ACCOUNT_WHATSAPP } from '../../src/db/models/account.model';
import { NOTIFICATION_TYPES } from '../../src/db/models/notification.model';
import {
  META_PAYERS,
  SYNC_STATUSES,
  WA_ACTIVE_STATUSES,
  WA_CHANNEL_STATUSES,
  WA_LIMIT_TIERS,
  WA_MODES,
} from '../../src/db/models/whatsapp-channel.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { PERMISSIONS } from '../../src/modules/rbac/permissions';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import { AppError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';

describe('Phase 9 catalogue', () => {
  it('has 54 error codes incl. the seven WhatsApp / Meta codes', () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(54);
    expect(
      Object.entries(ERROR_CODES)
        .filter(([k]) => k.startsWith('WHATSAPP_') || k.startsWith('META_'))
        .map(([k, v]) => [k, v.status]),
    ).toEqual([
      ['WHATSAPP_NOT_CONFIGURED', 503],
      ['WHATSAPP_SIGNUP_FAILED', 422],
      ['WHATSAPP_NUMBER_IN_USE', 409],
      ['WHATSAPP_CHANNEL_LIMIT', 409],
      ['WHATSAPP_CHANNEL_NOT_READY', 409],
      ['META_API_ERROR', 502],
      ['META_SIGNATURE_INVALID', 401],
    ]);
    expect(new AppError('WHATSAPP_NUMBER_IN_USE').message).toBe(
      'This WhatsApp number is already connected to another account.',
    );
  });

  it('has 95 audit actions incl. the WhatsApp and Meta actions', () => {
    expect(AUDIT_ACTIONS).toHaveLength(95);
    expect(AUDIT_ACTIONS.filter((a) => a.startsWith('whatsapp.') || a.startsWith('meta.'))).toEqual(
      [
        'whatsapp.channel_connected',
        'whatsapp.channel_reconnected',
        'whatsapp.channel_setup_failed',
        'whatsapp.channel_registered',
        'whatsapp.credit_line_attached',
        'whatsapp.channel_renamed',
        'whatsapp.channel_disconnected',
        'whatsapp.channel_status_changed',
        'whatsapp.billing_mode_changed',
        'whatsapp.event_replayed',
        'meta.deauthorized',
        'meta.data_deletion_requested',
      ],
    );
  });

  it('has 17 notification types (11 + 6), the WS event, the queue and the permissions per role', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(17);
    expect(NOTIFICATION_TYPES.filter((t) => t.startsWith('whatsapp.'))).toEqual([
      'whatsapp.channel_needs_reconnect',
      'whatsapp.channel_restricted',
      'whatsapp.quality_low',
      'whatsapp.name_approved',
      'whatsapp.name_rejected',
      'whatsapp.channel_disconnected_by_admin',
    ]);
    expect(WS_EVENT_TYPES).toContain('whatsapp.channel.updated');
    expect(QUEUES.whatsapp).toBe('whatsapp');
    expect(PERMISSIONS).toEqual(expect.arrayContaining(['whatsapp.read', 'whatsapp.manage']));
    const has = (role: keyof typeof SYSTEM_ROLES, p: string) =>
      (SYSTEM_ROLES[role].permissions as string[]).includes(p);
    expect(
      ['owner', 'admin', 'manager', 'agent', 'viewer'].map((r) => has(r as never, 'whatsapp.read')),
    ).toEqual([true, true, true, true, true]);
    expect(
      ['owner', 'admin', 'manager', 'agent', 'viewer'].map((r) =>
        has(r as never, 'whatsapp.manage'),
      ),
    ).toEqual([true, true, false, false, false]);
  });

  it('model constants and limits', () => {
    expect(WA_ACTIVE_STATUSES).toEqual(WA_CHANNEL_STATUSES.filter((s) => s !== 'disconnected'));
    expect(WA_MODES).toEqual(['cloud_api', 'coexistence']);
    expect(META_PAYERS).toEqual(['platform', 'customer']);
    expect(SYNC_STATUSES).toContain('declined');
    expect(WA_LIMIT_TIERS).toContain('TIER_1K');
    expect(DEFAULT_ACCOUNT_WHATSAPP).toEqual({ metaPayer: 'platform' });
    expect(WHATSAPP_LIMITS).toMatchObject({
      maxChannelsPerAccount: 10,
      webhookMaxBytes: 3 * 1024 * 1024,
      webhookEventTtlDays: 7,
      deferredEventTtlDays: 30,
      webhookProcessAttempts: 5,
      graphTimeoutMs: 10_000,
      graphRetries: 3,
      pinLength: 6,
    });
  });
});
